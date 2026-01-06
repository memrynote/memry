/**
 * ContentArea Component
 * BlockNote-based block editor for note content
 * Uses shadcn/ui components for consistent styling
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SuggestionMenuController, useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import {
  BlockNoteSchema,
  defaultInlineContentSpecs,
  defaultBlockSpecs,
  type Block
} from '@blocknote/core'
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
import {
  createFileBlock,
  createFileBlockContent,
  serializeFileBlock,
  FILE_BLOCK_REGEX
} from './file-block'
import {
  HighlightReminderPopover,
  useTextSelection,
  type HighlightSelection
} from '@/components/reminder'

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

    segments.push(createWikiLinkInlineContent(target, alias))
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

function normalizeInlineContent(content: string | Array<any>): {
  content: string | Array<any>
  didChange: boolean
} {
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
  noteId,
  initialContent,
  contentType = 'html',
  placeholder = "Start writing, or press '/' for commands...",
  editable = true,
  onContentChange,
  onMarkdownChange,
  onHeadingsChange,
  onLinkClick,
  onInternalLinkClick,
  className,
  initialHighlight
}: ContentAreaProps) {
  // T030: Get current theme for dark mode support
  const { resolvedTheme } = useTheme()
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light'

  // T069: Drag state for visual feedback
  const [isDragging, setIsDragging] = useState(false)

  // T220-T222: Text selection state for highlight reminders
  const [highlightSelection, setHighlightSelection] = useState<HighlightSelection | null>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)

  // Ref to hold current noteId for upload function (since editor is created once)
  const noteIdRef = useRef<string | undefined>(noteId)
  useEffect(() => {
    noteIdRef.current = noteId
  }, [noteId])

  // Track if initial content has been loaded (prevents re-loading on prop changes)
  const initialContentLoadedRef = useRef(false)

  // Track if content is ready for saving (prevents saving empty content before load completes)
  const isContentReadyRef = useRef(false)

  // T069/T071: Schema with FileBlock for attachments
  const schema = useMemo(
    () =>
      BlockNoteSchema.create({
        blockSpecs: {
          ...defaultBlockSpecs,
          file: createFileBlock()
        },
        inlineContentSpecs: {
          ...defaultInlineContentSpecs,
          wikiLink: WikiLink
        }
      }),
    []
  )

  // T069: Upload function for BlockNote's built-in file handling
  // This handles images dropped directly into the editor
  const uploadFile = useCallback(async (file: File): Promise<string> => {
    const currentNoteId = noteIdRef.current
    if (!currentNoteId) {
      throw new Error('Cannot upload: no note selected')
    }

    const result = await notesService.uploadAttachment(currentNoteId, file)
    if (!result.success || !result.path) {
      throw new Error(result.error || 'Upload failed')
    }

    return result.path
  }, [])

  // Create the BlockNote editor
  const editor = useCreateBlockNote({
    schema,
    // Enable data-id attributes on blocks for scroll tracking (T078)
    setIdAttribute: true,
    // T069: Configure file upload for images and files
    uploadFile,
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

  const getWikiLinkItems = useCallback(async (query: string): Promise<WikiLinkSuggestionItem[]> => {
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
  }, [])

  const handleWikiLinkSelect = useCallback(
    (item: WikiLinkSuggestionItem) => {
      if (!item.target) return
      editor.insertInlineContent([createWikiLinkInlineContent(item.target, item.alias ?? '')], {
        updateSelection: true
      })
    },
    [editor]
  )

  // Parse content based on content type (only on initial mount)
  // We use a ref to prevent re-loading when the parent updates initialContent
  // This makes ContentArea an "uncontrolled" component for content
  useEffect(() => {
    // Skip if already loaded (prevents overwriting user edits when parent re-renders)
    if (initialContentLoadedRef.current) {
      return
    }
    initialContentLoadedRef.current = true

    async function loadContent() {
      try {
        if (typeof initialContent === 'string' && initialContent.trim()) {
          try {
            let content = initialContent
            let fileBlocksToInsert: Array<{
              url: string
              name: string
              size: number
              mimeType: string
            }> = []

            // Extract file block markers from markdown before parsing
            if (contentType === 'markdown') {
              const matches = content.matchAll(FILE_BLOCK_REGEX)
              for (const match of matches) {
                try {
                  const props = JSON.parse(match[1])
                  fileBlocksToInsert.push(props)
                } catch {
                  // Skip invalid markers
                }
              }
              // Remove markers from content before parsing
              content = content.replace(FILE_BLOCK_REGEX, '').trim()
            }

            let blocks
            if (contentType === 'markdown') {
              blocks = await editor.tryParseMarkdownToBlocks(content)
            } else {
              // Default to HTML parsing
              blocks = await editor.tryParseHTMLToBlocks(content)
            }

            // Add file blocks back
            if (fileBlocksToInsert.length > 0) {
              const fileBlocks = fileBlocksToInsert.map((props) => createFileBlockContent(props))
              blocks = [...blocks, ...fileBlocks]
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
      } finally {
        // Mark content as ready for saving (prevents race condition where empty content is saved)
        // Using finally ensures the flag is set even if parsing fails
        isContentReadyRef.current = true
      }
    }
    loadContent()
    // Note: We intentionally only depend on editor to run once on mount
    // The key prop on ContentArea should be used to force re-mount when content source changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

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
    // Only save if initial content has been loaded (prevents saving empty content from race condition)
    if (onMarkdownChange && isContentReadyRef.current) {
      try {
        let markdown = await editor.blocksToMarkdownLossy(blocks)

        // Serialize file blocks to markers (they're lost in markdown conversion)
        const fileBlocks = (blocks as Block[]).filter((b) => b.type === 'file')
        if (fileBlocks.length > 0) {
          // Append file block markers at the end
          const markers = fileBlocks.map((b) => {
            const props = b.props as unknown as {
              url: string
              name: string
              size: number
              mimeType: string
            }
            return serializeFileBlock(props)
          })
          markdown = markdown + '\n\n' + markers.join('\n')
        }

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

    // Add click listener to editor container
    const editorElement = document.querySelector('.bn-editor')
    editorElement?.addEventListener('click', handleClick)

    return () => {
      editorElement?.removeEventListener('click', handleClick)
    }
  }, [onLinkClick, onInternalLinkClick])

  // =========================================================================
  // T069: Drag-Drop Handlers for File Attachments
  // =========================================================================

  // Check if file is an image that BlockNote should handle
  const isImageFile = useCallback((file: File): boolean => {
    const imageTypes = [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/gif',
      'image/webp',
      'image/svg+xml'
    ]
    return imageTypes.includes(file.type.toLowerCase())
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only show drag state for file drops, not internal BlockNote drags
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only reset if leaving the container (not entering a child)
    const relatedTarget = e.relatedTarget as HTMLElement | null
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      setIsDragging(false)
    }
  }, [])

  // Handle non-image file drops (PDFs, docs, etc.)
  // Images are handled by BlockNote's built-in uploadFile
  const handleNonImageDrop = useCallback(
    async (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files)

      // Check if any files are non-images (we need to handle those)
      const nonImageFiles = files.filter((f) => !isImageFile(f))

      // If all files are images, let BlockNote handle them via uploadFile
      if (nonImageFiles.length === 0) {
        return false
      }

      // We have non-image files - prevent BlockNote from trying to handle them
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)

      // Skip if no noteId (can't upload attachments without a note)
      if (!noteId) {
        console.warn('[ContentArea] Cannot upload attachment: no noteId provided')
        return true
      }

      // Skip if not editable
      if (!editable) return true

      // Process each file (both images and non-images)
      for (const file of files) {
        try {
          // Upload via IPC
          const result = await notesService.uploadAttachment(noteId, file)

          if (!result.success) {
            console.error('[ContentArea] Upload failed:', result.error)
            continue
          }

          // Insert appropriate block based on file type
          if (result.type === 'image' && result.path) {
            // Insert image block (BlockNote's built-in image block)
            editor.insertBlocks(
              [
                {
                  type: 'image',
                  props: {
                    url: result.path,
                    caption: result.name || file.name,
                    previewWidth: 600
                  }
                }
              ],
              editor.getTextCursorPosition().block,
              'after'
            )
          } else if (result.path) {
            // Insert file block (custom FileBlock for PDFs, docs, etc.)
            editor.insertBlocks(
              [
                createFileBlockContent({
                  url: result.path,
                  name: result.name || file.name,
                  size: result.size || file.size,
                  mimeType: result.mimeType || file.type
                })
              ],
              editor.getTextCursorPosition().block,
              'after'
            )
          }
        } catch (error) {
          console.error('[ContentArea] Failed to upload file:', file.name, error)
        }
      }

      return true
    },
    [noteId, editable, editor, isImageFile]
  )

  // Use capture phase to intercept drops before BlockNote
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const captureDropHandler = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files || [])
      const hasNonImageFiles = files.some((f) => !isImageFile(f))

      if (hasNonImageFiles) {
        // Prevent BlockNote from handling - we'll handle in React handler
        e.preventDefault()
        e.stopPropagation()

        // Create a synthetic React event to trigger our handler
        handleNonImageDrop({
          ...e,
          dataTransfer: e.dataTransfer,
          preventDefault: () => e.preventDefault(),
          stopPropagation: () => e.stopPropagation(),
          currentTarget: container
        } as unknown as React.DragEvent)
      }
    }

    // Use capture phase to intercept before BlockNote's bubbling handler
    container.addEventListener('drop', captureDropHandler, { capture: true })

    return () => {
      container.removeEventListener('drop', captureDropHandler, { capture: true })
    }
  }, [isImageFile, handleNonImageDrop])

  // Regular drag leave handler for visual feedback
  const handleDrop = useCallback(() => {
    setIsDragging(false)
  }, [])

  // T220-T222: Track text selection for highlight reminders
  useTextSelection({
    containerRef: editorContainerRef,
    onSelectionChange: setHighlightSelection,
    minLength: 10, // Require at least 10 characters
    enabled: editable && !!noteId
  })

  // Clear selection when reminder is created
  const handleHighlightReminderCreated = useCallback(() => {
    setHighlightSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  // Scroll to and highlight text when navigating from a reminder
  useEffect(() => {
    if (!initialHighlight?.text || !editorContainerRef.current) return

    // Wait for content to be loaded
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
          // Found the text - scroll into view
          const parentElement = node.parentElement
          if (parentElement) {
            parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' })

            // Apply temporary highlight using CSS
            const originalBg = parentElement.style.backgroundColor
            parentElement.style.backgroundColor = 'rgba(251, 191, 36, 0.4)' // amber-400 with 40% opacity
            parentElement.style.transition = 'background-color 0.3s ease'

            // Remove highlight after 3 seconds
            setTimeout(() => {
              parentElement.style.backgroundColor = originalBg
            }, 3000)
          }
          break
        }
      }
    }

    // Delay to ensure content is rendered
    const timeoutId = setTimeout(scrollToHighlight, 500)
    return () => clearTimeout(timeoutId)
  }, [initialHighlight])

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Note editor"
      aria-busy={!isContentReadyRef.current}
      className={cn(
        'content-area h-full flex flex-col relative',
        isDragging && 'ring-2 ring-primary ring-offset-2 bg-primary/5',
        className
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none"
          aria-live="polite"
          aria-label="Drop zone active - release to attach files"
        >
          <div className="text-center">
            <div className="text-4xl mb-2" aria-hidden="true">
              📎
            </div>
            <p className="text-lg font-medium text-muted-foreground">Drop files to attach</p>
          </div>
        </div>
      )}

      {/* BlockNote Editor */}
      <div
        ref={editorContainerRef}
        className="bn-container flex-1 min-h-[300px] relative"
        role="application"
        aria-label="Rich text editor"
      >
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

        {/* T220-T222: Highlight reminder popover */}
        {noteId && highlightSelection && (
          <HighlightReminderPopover
            noteId={noteId}
            selection={highlightSelection}
            onClose={() => setHighlightSelection(null)}
            onReminderCreated={handleHighlightReminderCreated}
            containerRef={editorContainerRef}
          />
        )}
      </div>
    </div>
  )
})

export default ContentArea
