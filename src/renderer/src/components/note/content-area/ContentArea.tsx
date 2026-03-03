/**
 * ContentArea Component
 * BlockNote-based block editor for note content
 * Uses shadcn/ui components for consistent styling
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */
// BlockNote uses dynamic content types with 'any' internally - these errors are unavoidable

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SuggestionMenuController, useCreateBlockNote, FormattingToolbar } from '@blocknote/react'
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

import type * as Y from 'yjs'
import { cn } from '@/lib/utils'
import { fuzzySearch } from '@/lib/fuzzy-search'
import { notesService } from '@/services/notes-service'
import { useYjsCollaboration } from '@/sync/use-yjs-collaboration'
import { useSync } from '@/contexts/sync-context'
import type { ContentAreaProps, HeadingInfo } from './types'
import { createWikiLinkInlineContent, WikiLink } from './wiki-link'
import { WikiLinkMenu, type WikiLinkSuggestionItem } from './wiki-link-menu'
import { BlockDropIndicator, EmptyDocumentDropIndicator } from './block-drop-indicator'
import { findDropTarget, type DropTarget } from './drop-target-utils'
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
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:ContentArea')

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

  function processBlock(block: Block): void {
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

  blocks.forEach((block) => processBlock(block))
  return headings
}

// =============================================================================
// WIKI LINK UTILITIES
// =============================================================================

const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

function splitWikiLinkQuery(query: string): { search: string; alias: string } {
  const [rawTarget, rawAlias] = query.split('|', 2)
  return {
    search: rawTarget?.trim() ?? '',
    alias: rawAlias?.trim() ?? ''
  }
}

function createStyledText(
  text: string,
  styles: Record<string, boolean | string>
): { type: string; text: string; styles: Record<string, boolean | string> } {
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
  // Quick check: if no wiki link markers exist in the content, skip the expensive tree walk
  // This is a performance optimization since most content won't have wiki links
  const blockStr = JSON.stringify(blocks)
  if (!blockStr.includes('[[')) {
    return { blocks, didChange: false }
  }

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

function normalizeMarkdownHardBreaks(markdown: string): string {
  const lines = markdown.split('\n')
  const normalized: string[] = []
  let inCodeBlock = false

  for (const line of lines) {
    let lineBody = line
    let lineEnding = ''

    if (lineBody.endsWith('\r')) {
      lineEnding = '\r'
      lineBody = lineBody.slice(0, -1)
    }

    const trimmed = lineBody.trimStart()
    const isFence = trimmed.startsWith('```') || trimmed.startsWith('~~~')

    if (isFence) {
      inCodeBlock = !inCodeBlock
      normalized.push(lineBody + lineEnding)
      continue
    }

    if (!inCodeBlock) {
      const match = lineBody.match(/(\\+)$/)
      if (match && match[1].length % 2 === 1) {
        const nextLine = lineBody.slice(0, -1)
        if (nextLine.trim() === '') {
          continue
        }
        normalized.push(nextLine + lineEnding)
        continue
      }
    }

    normalized.push(lineBody + lineEnding)
  }

  return normalized.join('\n')
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
interface ContentAreaEditorProps extends ContentAreaProps {
  yjsFragment?: Y.XmlFragment
  isRemoteUpdateRef?: React.RefObject<boolean>
}

const ContentAreaEditor = memo(function ContentAreaEditor({
  noteId,
  initialContent,
  contentType = 'html',
  placeholder = "Start writing, or press '/' for commands...",
  editable = true,
  stickyToolbar = false,
  onContentChange,
  onMarkdownChange,
  onHeadingsChange,
  onLinkClick,
  onInternalLinkClick,
  className,
  initialHighlight,
  yjsFragment,
  isRemoteUpdateRef
}: ContentAreaEditorProps) {
  // T030: Get current theme for dark mode support
  const { resolvedTheme } = useTheme()
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light'

  // T069: Drag state for visual feedback
  const [isDragging, setIsDragging] = useState(false)

  // Block-level drop target state (for Notion-style file drops)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  // T220-T222: Text selection state for highlight reminders
  const [highlightSelection, setHighlightSelection] = useState<HighlightSelection | null>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)

  // Container ref for drag-drop position calculations (intercepts drops before BlockNote)
  const containerRef = useRef<HTMLDivElement>(null)

  // Ref to hold current noteId for upload function (since editor is created once)
  const noteIdRef = useRef<string | undefined>(noteId)
  useEffect(() => {
    noteIdRef.current = noteId
  }, [noteId])

  // Track if initial content has been loaded (prevents re-loading on prop changes)
  const initialContentLoadedRef = useRef(false)

  // Track if content is ready for saving (prevents saving empty content before load completes)
  const isContentReadyRef = useRef(false)

  // Debounce timers for expensive operations (prevents lag during typing)
  const markdownDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const headingsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup debounce timers on unmount
  useEffect(() => {
    return () => {
      if (markdownDebounceRef.current) clearTimeout(markdownDebounceRef.current)
      if (headingsDebounceRef.current) clearTimeout(headingsDebounceRef.current)
    }
  }, [])

  // Global event listeners to reset drag state when drag is cancelled or tab loses focus
  // This fixes the bug where the overlay gets stuck when user cancels the drag
  useEffect(() => {
    const resetDragState = (): void => {
      setIsDragging(false)
      setDropTarget(null)
    }

    // dragend fires when the drag operation ends (including cancel via Escape)
    window.addEventListener('dragend', resetDragState)

    // Reset when user switches to another tab
    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        resetDragState()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Reset when window loses focus
    window.addEventListener('blur', resetDragState)

    return () => {
      window.removeEventListener('dragend', resetDragState)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('blur', resetDragState)
    }
  }, [])

  // Apply subtle highlight to the target block when dragging over it
  useEffect(() => {
    if (!dropTarget || !containerRef.current) return

    const blockElement = containerRef.current.querySelector(`[data-id="${dropTarget.blockId}"]`)
    if (!blockElement) return

    // Add highlight class
    blockElement.classList.add('bg-primary/5', 'transition-colors', 'duration-150')

    return () => {
      // Remove highlight class on cleanup
      blockElement.classList.remove('bg-primary/5', 'transition-colors', 'duration-150')
    }
  }, [dropTarget])

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
    },
    // T140: Yjs collaboration (when fragment is available from IPC provider)
    ...(yjsFragment
      ? {
          collaboration: {
            fragment: yjsFragment,
            user: { name: 'Local User', color: '#3b82f6' }
          }
        }
      : {})
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
        log.error('Failed to load wiki link suggestions', error)
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

    // When Yjs collaboration is active, content comes from Y.Doc — skip file-based loading
    if (yjsFragment) {
      isContentReadyRef.current = true
      if (onHeadingsChange) {
        const headings = extractHeadings(editor.document as Block[])
        onHeadingsChange(headings)
      }
      return
    }

    async function loadContent(): Promise<void> {
      try {
        if (typeof initialContent === 'string' && initialContent.trim()) {
          try {
            let content = initialContent
            const fileBlocksToInsert: Array<{
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
              content = normalizeMarkdownHardBreaks(content)
            }

            let blocks
            if (contentType === 'markdown') {
              // eslint-disable-next-line @typescript-eslint/await-thenable -- BlockNote types are incorrect, this is async
              blocks = await editor.tryParseMarkdownToBlocks(content)
            } else {
              // Default to HTML parsing
              // eslint-disable-next-line @typescript-eslint/await-thenable -- BlockNote types are incorrect, this is async
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
            log.error(`Failed to parse ${contentType} content`, error)
          }
        } else if (Array.isArray(initialContent) && initialContent.length > 0) {
          // If it's already blocks, replace the document
          const normalized = normalizeWikiLinks(initialContent)
          editor.replaceBlocks(editor.document, normalized.blocks)
        }
      } finally {
        // Mark content as ready for saving (prevents race condition where empty content is saved)
        // Using finally ensures the flag is set even if parsing fails
        isContentReadyRef.current = true
        if (onHeadingsChange) {
          const headings = extractHeadings(editor.document as Block[])
          onHeadingsChange(headings)
        }
      }
    }
    void loadContent()
    // Note: We intentionally only depend on editor to run once on mount
    // The key prop on ContentArea should be used to force re-mount when content source changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Handle content changes with debouncing for expensive operations
  // This prevents typing lag by deferring markdown conversion and heading extraction
  const handleChange = useCallback(() => {
    const blocks = editor.document

    // Check for wiki links that need normalization (fast check with early exit optimization)
    const normalized = normalizeWikiLinks(blocks as Block[])
    if (normalized.didChange) {
      editor.replaceBlocks(editor.document, normalized.blocks)
      return
    }

    // Notify parent of content changes (blocks) - synchronous, lightweight
    onContentChange?.(blocks as Block[])

    // Skip save for remote Y.Doc updates — content came from another device via CRDT,
    // re-saving would enqueue a metadata push and trigger a sync ping-pong loop
    if (isRemoteUpdateRef?.current) return

    // Debounce markdown conversion (150ms) - expensive async operation
    // This is the main performance optimization: converts blocks to markdown only after typing pauses
    if (onMarkdownChange && isContentReadyRef.current) {
      if (markdownDebounceRef.current) {
        clearTimeout(markdownDebounceRef.current)
      }
      markdownDebounceRef.current = setTimeout(async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/await-thenable -- BlockNote types are incorrect, this is async
          let markdown = await editor.blocksToMarkdownLossy(editor.document)

          // Serialize file blocks to markers (they're lost in markdown conversion)
          const fileBlocks = (editor.document as Block[]).filter((b) => b.type === 'file')
          if (fileBlocks.length > 0) {
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
          log.error('Failed to convert blocks to markdown', error)
        }
      }, 150)
    }

    // Debounce heading extraction (200ms) - requires tree walk
    if (onHeadingsChange) {
      if (headingsDebounceRef.current) {
        clearTimeout(headingsDebounceRef.current)
      }
      headingsDebounceRef.current = setTimeout(() => {
        const headings = extractHeadings(editor.document as Block[])
        onHeadingsChange(headings)
      }, 200)
    }
  }, [editor, onContentChange, onMarkdownChange, onHeadingsChange])

  // Handle link clicks
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

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.stopPropagation()

      if (!e.dataTransfer.types.includes('Files')) return

      e.preventDefault()

      setIsDragging(true)

      const target = findDropTarget(e.clientY, containerRef)
      setDropTarget(target)
    },
    [containerRef]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // Use bounding rect check instead of relatedTarget (more reliable)
    // relatedTarget can be null or unreliable with shadow DOM elements
    const rect = e.currentTarget.getBoundingClientRect()
    const { clientX: x, clientY: y } = e

    // Only reset if cursor has actually left the container bounds
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setIsDragging(false)
      setDropTarget(null)
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

      // Capture the drop target position before clearing state
      const insertTarget = dropTarget
      setIsDragging(false)
      setDropTarget(null)

      // Skip if no noteId (can't upload attachments without a note)
      if (!noteId) {
        log.warn('Cannot upload attachment: no noteId provided')
        return true
      }

      // Skip if not editable
      if (!editable) return true

      // Determine reference block and placement from drop target
      // If we have a specific drop target, use it; otherwise fall back to cursor position
      let referenceBlockId: string
      let placement: 'before' | 'after' = 'after'

      if (insertTarget) {
        referenceBlockId = insertTarget.blockId
        placement = insertTarget.position
      } else {
        referenceBlockId = editor.getTextCursorPosition().block.id
      }

      // Process each file (both images and non-images)
      for (const file of files) {
        try {
          // Upload via IPC
          const result = await notesService.uploadAttachment(noteId, file)

          if (!result.success) {
            log.error('Upload failed', result.error)
            continue
          }

          // Insert appropriate block based on file type at the target position
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
              referenceBlockId,
              placement
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
              referenceBlockId,
              placement
            )
          }

          // After inserting the first file, subsequent files should go after it
          // This keeps files in the order they were dropped
          placement = 'after'
        } catch (error) {
          log.error('Failed to upload file', file.name, error)
        }
      }

      return true
    },
    [noteId, editable, editor, isImageFile, dropTarget]
  )

  // Use capture phase to intercept drops before BlockNote
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const captureDropHandler = (e: DragEvent): void => {
      const files = Array.from(e.dataTransfer?.files || [])
      const hasNonImageFiles = files.some((f) => !isImageFile(f))

      if (hasNonImageFiles) {
        // Prevent BlockNote from handling - we'll handle in React handler
        e.preventDefault()
        e.stopPropagation()

        // Create a synthetic React event to trigger our handler
        void handleNonImageDrop({
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

  // Reset drag state when drop occurs (for both image and non-image files)
  const handleDrop = useCallback(() => {
    setIsDragging(false)
    setDropTarget(null)
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
      className={cn('content-area h-full flex flex-col relative', className)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Block-level drop indicator - shows where file will be inserted */}
      {isDragging && dropTarget && (
        <BlockDropIndicator dropTarget={dropTarget} containerRef={containerRef} />
      )}

      {/* Empty document drop indicator - simple line at top when no blocks */}
      {isDragging && !dropTarget && <EmptyDocumentDropIndicator />}

      {/* BlockNote Editor */}
      <div
        ref={editorContainerRef}
        className={cn(
          'bn-container flex-1 min-h-[300px] relative',
          stickyToolbar && 'sticky-toolbar-enabled'
        )}
        role="application"
        aria-label="Rich text editor"
      >
        <BlockNoteView
          editor={editor}
          editable={editable}
          onChange={(): void => {
            void handleChange()
          }}
          theme={editorTheme}
          formattingToolbar={!stickyToolbar}
        >
          {stickyToolbar && <FormattingToolbar />}
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

export const ContentArea = memo(function ContentArea(props: ContentAreaProps) {
  const { state } = useSync()
  const syncActive = state.status === 'idle' || state.status === 'syncing'
  const { fragment, isReady, isRemoteUpdateRef } = useYjsCollaboration({
    noteId: props.noteId,
    enabled: syncActive
  })

  if (syncActive && props.noteId && !isReady) {
    return (
      <div className={cn('content-area h-full flex flex-col', props.className)}>
        <div className="flex-1 animate-pulse bg-muted/10 rounded-md" />
      </div>
    )
  }

  return (
    <ContentAreaEditor
      {...props}
      yjsFragment={isReady && fragment ? fragment : undefined}
      isRemoteUpdateRef={isRemoteUpdateRef}
    />
  )
})

export default ContentArea
