/* eslint-disable @typescript-eslint/no-explicit-any */

import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  SuggestionMenuController,
  useCreateBlockNote,
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems
} from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { useTheme } from 'next-themes'
import { AIMenuController, getAISlashMenuItems } from '@blocknote/xl-ai'
import { CustomAIMenu } from './ai-menu'
import { en as aiEn } from '@blocknote/xl-ai/locales'
import { en as coreEn } from '@blocknote/core/locales'

import '@blocknote/shadcn/style.css'
import '@blocknote/xl-ai/style.css'

import type * as Y from 'yjs'
import { cn } from '@/lib/utils'
import type { Comment, CommentAnchorInput, CommentMentionRef } from '@/services/comments-service'
import { CommentsRail, type CommentRailRect } from '@/components/comments/comments-rail'
import { notesService } from '@/services/notes-service'
import { useYjsCollaboration } from '@/sync/use-yjs-collaboration'
import { useSync } from '@/contexts/sync-context'
import { useWikiLinkHover } from '@/hooks/use-wiki-link-hover'
import { useAIInlineContext } from '@/contexts/ai-inline-context'
import { useAISettingsContext } from '@/contexts/ai-settings-context'
import type { ContentAreaProps } from './types'
import { WikiLinkMenu } from './wiki-link-menu'
import { TagSuggestionPopover } from './tag-suggestion-popover'
import { WikiLinkPreviewCard } from './wiki-link-preview-card'
import { BlockDropIndicator, EmptyDocumentDropIndicator } from './block-drop-indicator'
import { getCalloutSlashMenuItem } from './callout-block'
import { getTaskSlashMenuItem } from './task-block'
import { tasksService } from '@/services/tasks-service'
import { useTasksOptional } from '@/contexts/tasks'
import { parseQuickAdd } from '@/lib/quick-add-parser'
import { formatDateKey } from '@/lib/task-utils'
import { editorSchema } from './editor-schema'
import { analyzeTaskIntents } from './scan-task-intents'
import { useSidebarDrillDown } from '@/contexts/sidebar-drill-down'

import {
  useBlockNoteSetup,
  useBlockMarqueeSelection,
  useEditorDragDrop,
  useEditorFileUpload,
  useEditorSync,
  useTagSuggestions,
  useWikiLinkSuggestions,
  usePasteLinkMenu
} from './hooks'
import { BlockMarqueeOverlay } from './block-marquee-overlay'
import { PasteLinkMenu } from './paste-link-menu'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'
import { extractDomain, fetchLinkPreview } from '@/lib/url-metadata'
import { createLinkMentionContent } from './link-mention'
import type { PasteLinkOption } from './hooks/use-paste-link-menu'
import { useT } from '@memry/i18n/renderer'
import {
  CompactSelectionFormattingToolbar,
  SelectionCommentToolbarProvider
} from './selection-formatting-toolbar'
import { CommentAdd } from '@/lib/icons'

const PRIORITY_REVERSE: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }

interface SelectionCommentAnchor extends CommentAnchorInput {
  x: number
  y: number
}

interface CommentHighlightRect {
  id: string
  quote: string
  left: number
  top: number
  width: number
  height: number
}

function elementFromNode(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

function findTextRange(root: HTMLElement, quote: string): Range | null {
  const fullText = root.textContent ?? ''
  const start = fullText.indexOf(quote)
  if (start === -1) return null
  const end = start + quote.length
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)

  let offset = 0
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const nextOffset = offset + node.data.length

    if (!startNode && start >= offset && start <= nextOffset) {
      startNode = node
      startOffset = start - offset
    }

    if (startNode && end >= offset && end <= nextOffset) {
      endNode = node
      endOffset = end - offset
      break
    }

    offset = nextOffset
  }

  if (!startNode || !endNode) return null

  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

function rangeToHighlightRect(
  range: Range,
  container: HTMLElement,
  id: string,
  quote: string
): CommentHighlightRect | null {
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  const containerRect = container.getBoundingClientRect()

  return {
    id,
    quote,
    left: rect.left - containerRect.left,
    top: rect.top - containerRect.top,
    width: rect.width,
    height: rect.height
  }
}

function readSelectionCommentAnchor(
  root: HTMLElement,
  container: HTMLElement
): SelectionCommentAnchor | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

  const range = selection.getRangeAt(0)
  const selectionElement = elementFromNode(range.commonAncestorContainer)
  if (!selectionElement || !root.contains(selectionElement)) return null

  const selectedQuote = selection.toString().trim()
  if (!selectedQuote) return null

  const rangeRect = range.getBoundingClientRect()
  if (rangeRect.width === 0 && rangeRect.height === 0) return null

  const containerRect = container.getBoundingClientRect()
  const fullText = root.textContent ?? ''
  const rangeStart = fullText.indexOf(selectedQuote)
  const rangeEnd = rangeStart >= 0 ? rangeStart + selectedQuote.length : null
  const blockId =
    elementFromNode(range.startContainer)?.closest('[data-id]')?.getAttribute('data-id') ?? null

  return {
    selectedQuote,
    blockId,
    rangeStart: rangeStart >= 0 ? rangeStart : null,
    rangeEnd,
    prefix: rangeStart >= 0 ? fullText.slice(Math.max(0, rangeStart - 40), rangeStart) : null,
    suffix:
      rangeEnd !== null ? fullText.slice(rangeEnd, Math.min(fullText.length, rangeEnd + 40)) : null,
    x: rangeRect.left - containerRect.left,
    y: rangeRect.top - containerRect.top
  }
}

function readBlockCommentAnchor(
  root: HTMLElement,
  container: HTMLElement,
  block: HTMLElement
): SelectionCommentAnchor | null {
  if (!root.contains(block)) return null

  const selectedQuote = block.textContent?.trim() ?? ''
  if (!selectedQuote) return null

  const blockRect = block.getBoundingClientRect()
  if (blockRect.width === 0 && blockRect.height === 0) return null

  const containerRect = container.getBoundingClientRect()
  const fullText = root.textContent ?? ''
  const rangeStart = fullText.indexOf(selectedQuote)
  const rangeEnd = rangeStart >= 0 ? rangeStart + selectedQuote.length : null

  return {
    selectedQuote,
    blockId: block.getAttribute('data-id'),
    rangeStart: rangeStart >= 0 ? rangeStart : null,
    rangeEnd,
    prefix: rangeStart >= 0 ? fullText.slice(Math.max(0, rangeStart - 40), rangeStart) : null,
    suffix:
      rangeEnd !== null ? fullText.slice(rangeEnd, Math.min(fullText.length, rangeEnd + 40)) : null,
    x: blockRect.left - containerRect.left,
    y: blockRect.top - containerRect.top
  }
}

function findBlockWithLinkMention(
  blocks: any[],
  url: string
): { block: any; index: number } | null {
  for (const block of blocks) {
    const content = (block.content ?? []) as any[]
    const idx = content.findIndex((c: any) => c.type === 'linkMention' && c.props?.url === url)
    if (idx !== -1) return { block, index: idx }
    if (block.children?.length) {
      const found = findBlockWithLinkMention(block.children, url)
      if (found) return found
    }
  }
  return null
}

// =============================================================================
// CONTENT AREA EDITOR (inner component with all hooks)
// =============================================================================

interface ContentAreaEditorProps extends ContentAreaProps {
  yjsFragment?: Y.XmlFragment
  isRemoteUpdateRef?: React.RefObject<boolean>
}

const ContentAreaEditor = memo(function ContentAreaEditor({
  noteId,
  initialContent,
  contentType = 'html',
  placeholder,
  editable = true,
  stickyToolbar = false,
  spellCheck,
  onContentChange,
  onMarkdownChange,
  onHeadingsChange,
  onLinkClick,
  onInternalLinkClick,
  className,
  initialHighlight,
  noteTags,
  tagColorMap,
  onInlineTagsChange,
  focusAtEndRef,
  comments = [],
  commentTargetType,
  commentTargetId,
  activeCommentId,
  onSaveCommentRequest,
  onUpdateCommentRequest,
  onDeleteCommentRequest,
  onCommentHighlightClick,
  onCommentOrphanIdsChange,
  yjsFragment,
  isRemoteUpdateRef,
  marqueeZoneEl
}: ContentAreaEditorProps) {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const { resolvedTheme } = useTheme()
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const { openTag } = useSidebarDrillDown()
  const { enabled: aiEnabled } = useAISettingsContext()
  const { port: aiPort, error: aiError, retry: retryAI } = useAIInlineContext()
  const resolvedPlaceholder = placeholder ?? t('editor.content.placeholder')

  const tasksCtx = useTasksOptional()
  const dismissedBlocksRef = useRef(new Set<string>())
  const knownTaskBlockIdsRef = useRef<Set<string>>(new Set())
  // Debounced standalone-task auto-convert. Holds the timer + the blockId we
  // intend to convert when it fires. The delay (CONVERT_DEBOUNCE_MS) is the
  // window in which the user can press Tab to indent the new checkbox under a
  // sibling taskBlock instead of having it auto-promoted to a top-level task.
  const pendingConvertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingConvertBlockIdRef = useRef<string | null>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const selectionCommentAnchorRef = useRef<SelectionCommentAnchor | null>(null)
  const [selectionCommentAnchor, setSelectionCommentAnchor] =
    useState<SelectionCommentAnchor | null>(null)
  const [draftCommentAnchor, setDraftCommentAnchor] = useState<SelectionCommentAnchor | null>(null)
  const [hoveredBlockCommentAnchor, setHoveredBlockCommentAnchor] =
    useState<SelectionCommentAnchor | null>(null)
  const [hoveredBlockButtonPosition, setHoveredBlockButtonPosition] = useState<{
    x: number
    y: number
  } | null>(null)
  const [commentHighlightRects, setCommentHighlightRects] = useState<CommentHighlightRect[]>([])
  const [draftCommentRect, setDraftCommentRect] = useState<CommentHighlightRect | null>(null)
  const noteIdRef = useRef<string | undefined>(noteId)
  const wikiLinkHover = useWikiLinkHover(editorContainerRef)

  // Keep noteIdRef in sync (used by uploadFile closure)
  useEffect(() => {
    noteIdRef.current = noteId
  }, [noteId])

  // Upload function — defined before editor creation so BlockNote can use it
  const uploadFile = useCallback(async (file: File): Promise<string> => {
    const currentNoteId = noteIdRef.current
    if (!currentNoteId) throw new Error('Cannot upload: no note selected')
    const result = await notesService.uploadAttachment(currentNoteId, file)
    if (!result.success || !result.path) throw new Error(result.error || 'Upload failed')
    return result.path
  }, [])

  // Create the BlockNote editor instance
  const editor = useCreateBlockNote({
    schema: editorSchema,
    setIdAttribute: true,
    uploadFile,
    placeholders: {
      default: resolvedPlaceholder,
      heading: t('editor.content.headingPlaceholder'),
      bulletListItem: t('editor.content.listPlaceholder'),
      numberedListItem: t('editor.content.listPlaceholder'),
      checkListItem: t('editor.content.todoPlaceholder')
    },
    dictionary: { ...coreEn, ai: aiEn } as any,
    ...(yjsFragment
      ? {
          collaboration: {
            fragment: yjsFragment,
            user: { name: 'Local User', color: '#3b82f6' }
          }
        }
      : {})
  })

  // Hook #1: Editor setup (AI extension, spellcheck, links, highlight scroll)
  const { aiReady } = useBlockNoteSetup({
    editor,
    aiPort: aiEnabled ? aiPort : null,
    spellCheck,
    focusAtEndRef,
    editorContainerRef,
    onLinkClick,
    onInternalLinkClick,
    initialHighlight
  })

  // Hook #2: Content sync (initial load + debounced change handler)
  const { handleChange } = useEditorSync({
    editor,
    noteId,
    initialContent,
    contentType,
    yjsFragment,
    isRemoteUpdateRef,
    noteTags,
    tagColorMap,
    onContentChange,
    onMarkdownChange,
    onHeadingsChange,
    onInlineTagsChange
  })

  // Hook #3: Wiki link suggestions
  const { getWikiLinkItems, handleWikiLinkSelect } = useWikiLinkSuggestions(editor)

  // Hook #4: Tag suggestions + inline plugin
  const { handleTagSuggestionSelect } = useTagSuggestions({
    editor,
    editorContainerRef,
    tagColorMap
  })

  // Hook #5: Drag and drop state
  const { isDragging, dropTarget, handleDragOver, handleDragLeave, handleDrop } = useEditorDragDrop(
    { containerRef }
  )

  // Hook #6: File upload capture-phase drop (non-image files)
  useEditorFileUpload({
    editor,
    noteId,
    editable,
    containerRef,
    noteIdRef,
    dropTarget,
    onDragReset: handleDrop
  })

  // Hook #7: Paste link menu (URL / Mention / Embed)
  const handlePasteLinkSelect = useCallback(
    (option: PasteLinkOption, url: string) => {
      const block = editor.getTextCursorPosition()?.block
      if (!block) return
      const inlineContent = (block.content ?? []) as any[]

      const urlNodeIndex = inlineContent.findIndex(
        (c: any) =>
          (c.type === 'link' && c.href === url) ||
          (c.type === 'text' && typeof c.text === 'string' && c.text.includes(url))
      )

      if (option === 'url') return

      if (option === 'mention') {
        if (urlNodeIndex === -1) return
        const domain = extractDomain(url)
        const newContent = [...inlineContent]
        newContent[urlNodeIndex] = createLinkMentionContent(url, domain)
        editor.updateBlock(block, { content: newContent })

        fetchLinkPreview(url)
          .then((metadata) => {
            const found = findBlockWithLinkMention(editor.document, url)
            if (!found) return
            const updatedContent = [...((found.block.content ?? []) as any[])]
            updatedContent[found.index] = createLinkMentionContent(
              url,
              metadata.domain || domain,
              metadata.title,
              metadata.favicon
            )
            editor.updateBlock(found.block, { content: updatedContent })
          })
          .catch(() => {})
        return
      }

      if (option === 'embed') {
        const videoId = extractYouTubeVideoId(url)
        if (!videoId) return

        if (urlNodeIndex !== -1) {
          const newContent = inlineContent.filter((_: any, i: number) => i !== urlNodeIndex)
          editor.updateBlock(block, { content: newContent.length > 0 ? newContent : [] })
        }
        editor.insertBlocks(
          [{ type: 'youtubeEmbed' as any, props: { videoId, videoUrl: url } }],
          block,
          'after'
        )
      }
    },
    [editor]
  )

  const { state: pasteLinkState, handleSelect: handlePasteLinkOptionSelect } = usePasteLinkMenu({
    editorContainerRef,
    onSelect: handlePasteLinkSelect
  })

  const [innerContainerEl, setInnerContainerEl] = useState<HTMLDivElement | null>(null)
  const setEditorContainerRef = useCallback((el: HTMLDivElement | null) => {
    editorContainerRef.current = el
    setInnerContainerEl(el)
  }, [])

  // State (not just editorContainerRef) so the marquee hook's useEffect
  // re-runs when .bn-container first mounts — refs don't trigger effects.
  const triggerEl = marqueeZoneEl ?? innerContainerEl

  const getEditableRoot = useCallback((): HTMLElement | null => {
    const container = editorContainerRef.current
    return container?.querySelector<HTMLElement>('[contenteditable="true"]') ?? container
  }, [])

  const updateSelectionCommentAnchor = useCallback(() => {
    if (!editable || !commentTargetType || !commentTargetId || !onSaveCommentRequest) {
      selectionCommentAnchorRef.current = null
      setSelectionCommentAnchor(null)
      return
    }

    const root = getEditableRoot()
    const container = editorContainerRef.current
    if (!root || !container) {
      selectionCommentAnchorRef.current = null
      setSelectionCommentAnchor(null)
      return
    }

    const nextAnchor = readSelectionCommentAnchor(root, container)
    if (nextAnchor) selectionCommentAnchorRef.current = nextAnchor
    setSelectionCommentAnchor(nextAnchor)
  }, [editable, commentTargetType, commentTargetId, getEditableRoot, onSaveCommentRequest])

  useEffect(() => {
    if (!commentTargetType || !commentTargetId || !onSaveCommentRequest) return

    document.addEventListener('selectionchange', updateSelectionCommentAnchor)
    return () => {
      document.removeEventListener('selectionchange', updateSelectionCommentAnchor)
    }
  }, [commentTargetType, commentTargetId, onSaveCommentRequest, updateSelectionCommentAnchor])

  const clearHoveredBlockCommentAnchor = useCallback(() => {
    setHoveredBlockCommentAnchor(null)
    setHoveredBlockButtonPosition(null)
  }, [])

  const openSelectionCommentDraft = useCallback(() => {
    let anchor = selectionCommentAnchor ?? selectionCommentAnchorRef.current
    if (!anchor) {
      const root = getEditableRoot()
      const container = editorContainerRef.current
      if (root && container) anchor = readSelectionCommentAnchor(root, container)
    }
    if (!anchor) return
    selectionCommentAnchorRef.current = anchor
    setSelectionCommentAnchor(anchor)
    setDraftCommentAnchor(anchor)
    setDraftCommentRect(null)
    clearHoveredBlockCommentAnchor()
  }, [clearHoveredBlockCommentAnchor, getEditableRoot, selectionCommentAnchor])

  const openBlockCommentDraft = useCallback(
    (anchor: SelectionCommentAnchor | null = hoveredBlockCommentAnchor) => {
      if (!anchor) return
      setDraftCommentAnchor(anchor)
      setDraftCommentRect(null)
      setSelectionCommentAnchor(null)
      selectionCommentAnchorRef.current = null
      clearHoveredBlockCommentAnchor()
    },
    [clearHoveredBlockCommentAnchor, hoveredBlockCommentAnchor]
  )

  const handleEditorMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!editable || !commentTargetType || !commentTargetId || !onSaveCommentRequest) {
        clearHoveredBlockCommentAnchor()
        return
      }
      if (draftCommentAnchor) {
        clearHoveredBlockCommentAnchor()
        return
      }

      const target = elementFromNode(event.target as Node)
      if (!target || target.closest('[data-marquee-ignore]')) {
        clearHoveredBlockCommentAnchor()
        return
      }

      const root = getEditableRoot()
      const container = editorContainerRef.current
      const block = target.closest<HTMLElement>('[data-id]')
      if (!root || !container || !block || !container.contains(block)) {
        clearHoveredBlockCommentAnchor()
        return
      }

      const nextAnchor = readBlockCommentAnchor(root, container, block)
      if (!nextAnchor) {
        clearHoveredBlockCommentAnchor()
        return
      }

      const blockRect = block.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      setHoveredBlockCommentAnchor(nextAnchor)
      setHoveredBlockButtonPosition({
        x: blockRect.right - containerRect.left + 6,
        y: blockRect.top - containerRect.top + 1
      })
    },
    [
      clearHoveredBlockCommentAnchor,
      commentTargetId,
      commentTargetType,
      draftCommentAnchor,
      editable,
      getEditableRoot,
      onSaveCommentRequest
    ]
  )

  const recomputeCommentHighlights = useCallback(() => {
    const root = getEditableRoot()
    const container = editorContainerRef.current
    if (!root || !container) {
      setCommentHighlightRects([])
      setDraftCommentRect(null)
      onCommentOrphanIdsChange?.([])
      return
    }

    const nextRects: CommentHighlightRect[] = []
    const orphanIds: string[] = []

    for (const comment of comments) {
      if (comment.status === 'archived') continue
      const range = findTextRange(root, comment.selectedQuote)
      if (!range) {
        orphanIds.push(comment.id)
        continue
      }

      const rect = rangeToHighlightRect(range, container, comment.id, comment.selectedQuote)
      if (!rect) {
        orphanIds.push(comment.id)
        continue
      }

      nextRects.push(rect)
    }

    if (draftCommentAnchor) {
      const draftRange = findTextRange(root, draftCommentAnchor.selectedQuote)
      setDraftCommentRect(
        draftRange
          ? rangeToHighlightRect(draftRange, container, 'draft', draftCommentAnchor.selectedQuote)
          : null
      )
    } else {
      setDraftCommentRect(null)
    }

    setCommentHighlightRects(nextRects)
    onCommentOrphanIdsChange?.(orphanIds)
  }, [comments, draftCommentAnchor, getEditableRoot, onCommentOrphanIdsChange])

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(recomputeCommentHighlights)
    return () => cancelAnimationFrame(frame)
  }, [recomputeCommentHighlights, initialContent])

  const commentRailRects = useMemo<CommentRailRect[]>(
    () =>
      commentHighlightRects.map((rect) => ({
        id: rect.id,
        top: rect.top,
        height: rect.height
      })),
    [commentHighlightRects]
  )

  const draftCommentAnchorInput = useMemo<CommentAnchorInput | null>(() => {
    if (!draftCommentAnchor) return null
    const { x: _x, y: _y, ...anchor } = draftCommentAnchor
    return anchor
  }, [draftCommentAnchor])

  const handleSaveCommentDraft = useCallback(
    async (
      anchor: CommentAnchorInput,
      body: string,
      attachmentRefs: string[],
      mentionRefs: CommentMentionRef[]
    ): Promise<void> => {
      if (!onSaveCommentRequest) return
      await onSaveCommentRequest(anchor, body, attachmentRefs, mentionRefs)
      setDraftCommentAnchor(null)
      setDraftCommentRect(null)
      setSelectionCommentAnchor(null)
      selectionCommentAnchorRef.current = null
      clearHoveredBlockCommentAnchor()
    },
    [clearHoveredBlockCommentAnchor, onSaveCommentRequest]
  )

  const handleCancelCommentDraft = useCallback(() => {
    setDraftCommentAnchor(null)
    setDraftCommentRect(null)
    setSelectionCommentAnchor(null)
    selectionCommentAnchorRef.current = null
    clearHoveredBlockCommentAnchor()
  }, [clearHoveredBlockCommentAnchor])

  const handleRailCommentClick = useCallback(
    (comment: Comment) => {
      onCommentHighlightClick?.(comment.id)
      const highlight = editorContainerRef.current?.querySelector<HTMLElement>(
        `[data-comment-id="${comment.id}"]`
      )
      highlight?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    [onCommentHighlightClick]
  )

  // Finder-style multi-block marquee selection
  const marquee = useBlockMarqueeSelection({
    editor,
    blockContainerRef: editorContainerRef,
    triggerContainerEl: triggerEl,
    enabled: editable
  })

  const convertCheckboxToTask = useCallback(
    (blockId: string) => {
      dismissedBlocksRef.current.add(blockId)

      const block = editor.getBlock(blockId)
      if (!block) return

      const content = block.content as any[] | undefined
      const text =
        content
          ?.map((c: any) => (typeof c === 'string' ? c : (c.text ?? '')))
          .join('')
          .trim() ?? ''

      editor.updateBlock(block, {
        type: 'taskBlock' as any,
        props: { taskId: '', title: text, checked: false }
      })

      void (async () => {
        // Defense in depth: if Tab moved this block under another taskBlock
        // mid-flight (the analyzer's debounce should catch this and route to
        // convertCheckboxToSubtask, but races are possible), respect the
        // live parentTaskId and create as a subtask.
        const liveBlock = editor.getBlock(blockId)
        const liveParentTaskId = ((liveBlock?.props as any)?.parentTaskId as string) || ''

        let projects: any[] = tasksCtx?.projects ?? []
        if (projects.length === 0) {
          const res = await tasksService.listProjects()
          projects = res.projects ?? []
        }

        const defaultProject = projects.find((p: any) => p.isDefault || p.isInbox) ?? projects[0]
        if (!defaultProject) return

        let projectIdForCreate: string | null = null
        if (liveParentTaskId) {
          const parentTask = await tasksService.get(liveParentTaskId).catch(() => null)
          if (parentTask) projectIdForCreate = parentTask.projectId
        }

        const parsed = text
          ? parseQuickAdd(text, projects)
          : { title: '', priority: 'none', projectId: null, dueDate: null }

        try {
          const result = await tasksService.create({
            projectId: projectIdForCreate ?? parsed.projectId ?? defaultProject.id,
            ...(liveParentTaskId ? { parentId: liveParentTaskId } : {}),
            title: parsed.title,
            priority: PRIORITY_REVERSE[parsed.priority] ?? 0,
            dueDate: parsed.dueDate ? formatDateKey(parsed.dueDate) : null,
            linkedNoteIds: noteId ? [noteId] : []
          })
          if (result.success && result.task) {
            const freshBlock = editor.getBlock(blockId)
            if (freshBlock) {
              const currentTitle = (freshBlock.props as any).title || parsed.title
              const currentParentTaskId = ((freshBlock.props as any).parentTaskId as string) || ''
              editor.updateBlock(freshBlock, {
                props: {
                  taskId: result.task.id,
                  title: currentTitle,
                  checked: false,
                  parentTaskId: currentParentTaskId
                }
              })
              if (currentTitle && currentTitle !== result.task.title) {
                void tasksService.update({ id: result.task.id, title: currentTitle })
              }
            }
          }
        } catch {
          dismissedBlocksRef.current.delete(blockId)
        }
      })()
    },
    [editor, noteId, tasksCtx]
  )

  const convertCheckboxToSubtask = useCallback(
    (blockId: string, parentTaskId: string) => {
      dismissedBlocksRef.current.add(blockId)

      const block = editor.getBlock(blockId)
      if (!block) return

      const content = block.content as any[] | undefined
      const text =
        content
          ?.map((c: any) => (typeof c === 'string' ? c : (c.text ?? '')))
          .join('')
          .trim() ?? ''

      editor.updateBlock(block, {
        type: 'taskBlock' as any,
        props: { taskId: '', title: text, checked: false, parentTaskId }
      })

      void (async () => {
        try {
          const parentTask = await tasksService.get(parentTaskId)
          if (!parentTask) {
            dismissedBlocksRef.current.delete(blockId)
            return
          }

          const result = await tasksService.create({
            projectId: parentTask.projectId,
            parentId: parentTaskId,
            title: text,
            priority: 0,
            linkedNoteIds: noteId ? [noteId] : []
          })
          if (result.success && result.task) {
            const freshBlock = editor.getBlock(blockId)
            if (freshBlock) {
              const currentTitle = (freshBlock.props as any).title || text
              editor.updateBlock(freshBlock, {
                props: { taskId: result.task.id, title: currentTitle, checked: false, parentTaskId }
              })
              if (currentTitle && currentTitle !== result.task.title) {
                void tasksService.update({ id: result.task.id, title: currentTitle })
              }
            }
          }
        } catch {
          dismissedBlocksRef.current.delete(blockId)
        }
      })()
    },
    [editor, noteId]
  )

  const cancelPendingConvert = useCallback(() => {
    if (pendingConvertTimerRef.current) {
      clearTimeout(pendingConvertTimerRef.current)
      pendingConvertTimerRef.current = null
    }
    pendingConvertBlockIdRef.current = null
  }, [])

  // Debounce window for standalone task auto-conversion. Long enough that a
  // user typing `- [ ] foo` then Tab can land in the indent path before the
  // block is replaced with the read-only taskBlock renderer.
  const CONVERT_DEBOUNCE_MS = 600

  const schedulePendingConvert = useCallback(
    (blockId: string) => {
      if (pendingConvertBlockIdRef.current === blockId && pendingConvertTimerRef.current) {
        // Already scheduled for the same block — refresh the timer.
        clearTimeout(pendingConvertTimerRef.current)
      } else if (pendingConvertTimerRef.current) {
        clearTimeout(pendingConvertTimerRef.current)
      }

      pendingConvertBlockIdRef.current = blockId
      pendingConvertTimerRef.current = setTimeout(() => {
        pendingConvertTimerRef.current = null
        pendingConvertBlockIdRef.current = null

        // Re-scan: the structure may have changed during the debounce window
        // (e.g. user pressed Tab and the block became a child of another
        // taskBlock). Pick the latest intent for this block.
        const latest = analyzeTaskIntents(editor.document as any[], dismissedBlocksRef.current)
        if (latest.subtaskCandidate?.blockId === blockId) {
          convertCheckboxToSubtask(
            latest.subtaskCandidate.blockId,
            latest.subtaskCandidate.parentTaskId
          )
        } else if (latest.standaloneCandidate?.blockId === blockId) {
          convertCheckboxToTask(blockId)
        }
        // else: the block disappeared or was already converted, no-op.
      }, CONVERT_DEBOUNCE_MS)
    },
    [editor, convertCheckboxToSubtask, convertCheckboxToTask]
  )

  // Cleanup the debounce timer on unmount so a teardown mid-typing doesn't
  // mutate state on a torn-down editor.
  useEffect(() => {
    return () => {
      if (pendingConvertTimerRef.current) {
        clearTimeout(pendingConvertTimerRef.current)
      }
    }
  }, [])

  const createTaskForDraftBlock = useCallback(
    (blockId: string, title: string) => {
      dismissedBlocksRef.current.add(blockId)

      void (async () => {
        // Re-read the live block. Between the onChange that scheduled this
        // call and now, the renderer's Tab handler may have moved the block
        // into another taskBlock's children[] and pre-set `parentTaskId` on
        // its props. If we ignore that prop here we'll create a top-level
        // DB row for what the user already sees as a subtask, and the
        // demote-repair won't catch it (block prop already matches the tree
        // parent, so no mismatch fires).
        const liveBlock = editor.getBlock(blockId)
        const liveParentTaskId = ((liveBlock?.props as any)?.parentTaskId as string) || ''

        let projects: any[] = tasksCtx?.projects ?? []
        if (projects.length === 0) {
          const res = await tasksService.listProjects()
          projects = res.projects ?? []
        }

        const defaultProject = projects.find((p: any) => p.isDefault || p.isInbox) ?? projects[0]
        if (!defaultProject) return

        // If this draft is parented, inherit the parent task's projectId so
        // the subtask lands in the right project (mirrors convertCheckboxToSubtask).
        let projectIdForCreate: string | null = null
        if (liveParentTaskId) {
          const parentTask = await tasksService.get(liveParentTaskId).catch(() => null)
          if (parentTask) projectIdForCreate = parentTask.projectId
        }

        const parsed = title
          ? parseQuickAdd(title, projects)
          : { title: '', priority: 'none', projectId: null, dueDate: null }

        try {
          const result = await tasksService.create({
            projectId: projectIdForCreate ?? parsed.projectId ?? defaultProject.id,
            // When parented, force parentId — never let parseQuickAdd's
            // priority/date metadata leak into a top-level row.
            ...(liveParentTaskId ? { parentId: liveParentTaskId } : {}),
            title: parsed.title,
            priority: PRIORITY_REVERSE[parsed.priority] ?? 0,
            dueDate: parsed.dueDate ? formatDateKey(parsed.dueDate) : null,
            linkedNoteIds: noteId ? [noteId] : []
          })
          if (result.success && result.task) {
            const freshBlock = editor.getBlock(blockId)
            if (freshBlock) {
              const currentTitle = (freshBlock.props as any).title || parsed.title
              const currentParentTaskId = ((freshBlock.props as any).parentTaskId as string) || ''
              editor.updateBlock(freshBlock, {
                props: {
                  taskId: result.task.id,
                  title: currentTitle,
                  checked: false,
                  parentTaskId: currentParentTaskId
                }
              })
              if (currentTitle && currentTitle !== result.task.title) {
                void tasksService.update({ id: result.task.id, title: currentTitle })
              }
            }
          }
        } catch {
          dismissedBlocksRef.current.delete(blockId)
        }
      })()
    },
    [editor, noteId, tasksCtx]
  )

  const handleEditorContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      const checkListBlock = target.closest('[data-content-type="checkListItem"]')
      if (!checkListBlock) return

      const blockId = checkListBlock.getAttribute('data-id')
      if (!blockId) return

      const block = editor.getBlock(blockId)
      if (!block || block.type !== 'checkListItem') return

      e.preventDefault()
      convertCheckboxToTask(blockId)
    },
    [editor, convertCheckboxToTask]
  )

  // Backspace-at-start guard for taskBlock neighbours.
  //
  // Without this, pressing Backspace at column 0 of a paragraph that sits
  // directly below a taskBlock falls through to ProseMirror's default
  // backspace handler. taskBlock declares `content: 'none'` and renders
  // contentEditable={false}, so PM can't merge text into it — instead it
  // *deletes* the entire previous node. If that node is a parent taskBlock,
  // its subtask children get cascaded too: from the user's perspective the
  // whole task list above the cursor disappears with one keypress.
  //
  // Fix: intercept Backspace BEFORE PM, locate the visually-previous
  // taskBlock (diving into children[] when the previous top-level block
  // hosts subtasks), and focus its title input via the renderer's
  // clickable-title button. The user can then continue deleting characters
  // from the task title; once that title is empty, the renderer's own
  // Backspace branch (added in task-block-renderer.tsx) takes the block
  // down cleanly.
  useEffect(() => {
    const container = editorContainerRef.current
    if (!container) return

    const findPreviousTaskBlock = (currentBlockId: string): any => {
      const doc = editor.document as any[]
      const idx = doc.findIndex((b: any) => b.id === currentBlockId)
      if (idx <= 0) return null
      let candidate: any = doc[idx - 1]
      // Walk into children to find the visually-last task block. A parent
      // taskBlock with subtasks renders its children below itself, so the
      // visually-previous block is the deepest last child, not the parent.
      while (candidate?.children?.length) {
        const lastChild = candidate.children[candidate.children.length - 1]
        if (!lastChild) break
        candidate = lastChild
      }
      return candidate?.type === 'taskBlock' ? candidate : null
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Backspace') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return

      // Skip when the keypress originated in a regular HTML control (the
      // taskBlock title input or any other input/textarea) — those have
      // their own Backspace semantics handled inside the renderer.
      const target = e.target as HTMLElement | null
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return

      const tiptap = (editor as any)._tiptapEditor
      if (!tiptap) return
      const sel = tiptap.state.selection
      if (!sel?.empty) return
      // Cursor must be at the very start of its parent text block.
      if (sel.$from.parentOffset !== 0) return

      const cursor = editor.getTextCursorPosition()
      const currentBlock = cursor?.block as any
      if (!currentBlock) return
      // The taskBlock's own renderer handles its own Backspace path.
      if (currentBlock.type === 'taskBlock') return

      const prevTaskBlock = findPreviousTaskBlock(currentBlock.id)
      if (!prevTaskBlock) return

      const blockEl = container.querySelector<HTMLElement>(`[data-id="${prevTaskBlock.id}"]`)
      if (!blockEl) return
      // The clickable title (role="button") inside the renderer flips
      // isEditingTitle → true, which triggers a focus effect that places
      // the cursor at the end of the title input.
      const clickable = blockEl.querySelector<HTMLElement>('[role="button"][tabindex="0"]')
      if (!clickable) return

      e.preventDefault()
      e.stopPropagation()
      clickable.click()
    }

    container.addEventListener('keydown', handleKeyDown, true)
    return () => container.removeEventListener('keydown', handleKeyDown, true)
  }, [editor])

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t('editor.content.regionAria')}
      className={cn('content-area h-full flex flex-col relative', className)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && dropTarget && (
        <BlockDropIndicator dropTarget={dropTarget} containerRef={containerRef} />
      )}
      {isDragging && !dropTarget && <EmptyDocumentDropIndicator />}

      {aiEnabled && aiError && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/40">
          <span className="truncate">{aiError}</span>
          <button onClick={retryAI} className="shrink-0 underline hover:no-underline">
            {tCommon('button.retry')}
          </button>
        </div>
      )}

      <div
        ref={setEditorContainerRef}
        className={cn(
          'bn-container flex-1 min-h-[300px] relative',
          stickyToolbar && 'sticky-toolbar-enabled'
        )}
        role="application"
        aria-label={t('editor.content.richTextAria')}
        onContextMenu={handleEditorContextMenu}
        onMouseMove={handleEditorMouseMove}
        onMouseLeave={clearHoveredBlockCommentAnchor}
      >
        {!marqueeZoneEl && (
          <BlockMarqueeOverlay rect={marquee.marqueeRect} highlights={marquee.highlightRects} />
        )}
        <BlockNoteView
          editor={editor}
          editable={editable}
          onChange={(): void => {
            void handleChange()
            requestAnimationFrame(recomputeCommentHighlights)

            const intents = analyzeTaskIntents(editor.document as any[], dismissedBlocksRef.current)

            // Subtasks are unambiguous (the user already structured them as
            // children of a taskBlock) and convert immediately. Standalone
            // checkboxes are debounced so the user has time to press Tab to
            // promote them into a subtask before the read-only taskBlock
            // renderer steals focus.
            if (intents.subtaskCandidate) {
              cancelPendingConvert()
              convertCheckboxToSubtask(
                intents.subtaskCandidate.blockId,
                intents.subtaskCandidate.parentTaskId
              )
            } else if (intents.standaloneCandidate) {
              schedulePendingConvert(intents.standaloneCandidate.blockId)
            } else if (
              pendingConvertBlockIdRef.current &&
              !intents.currentTaskIds.has(pendingConvertBlockIdRef.current)
            ) {
              cancelPendingConvert()
            }

            if (intents.draftTaskBlock) {
              createTaskForDraftBlock(intents.draftTaskBlock.blockId, intents.draftTaskBlock.title)
            }

            // Tab-indented (demote): a top-level taskBlock that became a
            // child of another taskBlock via Tab. Wire up parentTaskId in the
            // block prop AND in the DB row.
            for (const demoted of intents.demotedTaskBlocks) {
              const block = editor.getBlock(demoted.blockId)
              if (!block) continue
              editor.updateBlock(block, {
                props: { ...block.props, parentTaskId: demoted.newParentTaskId }
              })
              void tasksService.update({
                id: demoted.taskId,
                parentId: demoted.newParentTaskId
              })
            }

            // Shift+Tab promoted: a top-level taskBlock that still carries a
            // stale parentTaskId. Clear both block prop and DB linkage.
            for (const orphan of intents.unindentedTaskBlocks) {
              const block = editor.getBlock(orphan.blockId)
              if (!block) continue
              editor.updateBlock(block, {
                props: { ...block.props, parentTaskId: '' }
              })
              void tasksService.update({ id: orphan.taskId, parentId: null })
            }

            for (const prevId of knownTaskBlockIdsRef.current) {
              if (!intents.currentTaskIds.has(prevId)) {
                void tasksService.delete(prevId)
              }
            }
            knownTaskBlockIdsRef.current = intents.currentTaskIds
          }}
          theme={editorTheme}
          formattingToolbar={false}
          slashMenu={false}
        >
          {!stickyToolbar && (
            <SelectionCommentToolbarProvider
              canComment={Boolean(selectionCommentAnchor)}
              onComment={openSelectionCommentDraft}
            >
              <FormattingToolbarController formattingToolbar={CompactSelectionFormattingToolbar} />
            </SelectionCommentToolbarProvider>
          )}
          {stickyToolbar && <FormattingToolbar />}
          {aiEnabled && aiReady && <AIMenuController aiMenu={CustomAIMenu} />}
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) => {
              const defaults = getDefaultReactSlashMenuItems(editor)
              const aiItems = aiEnabled && aiReady ? getAISlashMenuItems(editor) : []
              const calloutItem = getCalloutSlashMenuItem(editor, {
                title: t('editor.callout.title'),
                group: t('editor.callout.group'),
                subtext: t('editor.callout.subtext')
              })
              const taskItem = getTaskSlashMenuItem(editor)
              const all = [...defaults, calloutItem, taskItem, ...aiItems]
              if (!query) return all
              const lower = query.toLowerCase()
              return all.filter(
                (item) =>
                  item.title.toLowerCase().includes(lower) ||
                  item.aliases?.some((a) => a.toLowerCase().includes(lower))
              )
            }}
          />
          <SuggestionMenuController
            triggerCharacter="[["
            getItems={getWikiLinkItems}
            suggestionMenuComponent={WikiLinkMenu}
            onItemClick={(item) => void handleWikiLinkSelect(item)}
          />
        </BlockNoteView>

        {hoveredBlockCommentAnchor && hoveredBlockButtonPosition && (
          <button
            type="button"
            data-marquee-ignore
            data-testid="block-comment-affordance"
            aria-label={t('editor.comments.block.addAria')}
            title={t('editor.comments.block.addTitle')}
            className={cn(
              'absolute z-30 inline-flex size-7 items-center justify-center rounded-md',
              'border border-border/70 bg-background text-muted-foreground shadow-sm',
              'hover:bg-surface-active hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            )}
            style={{
              insetInlineStart: `${hoveredBlockButtonPosition.x}px`,
              top: `${hoveredBlockButtonPosition.y}px`
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              openBlockCommentDraft(hoveredBlockCommentAnchor)
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              openBlockCommentDraft(hoveredBlockCommentAnchor)
            }}
          >
            <CommentAdd className="size-4" aria-hidden="true" />
          </button>
        )}

        {draftCommentRect && (
          <span
            data-testid="comment-draft-highlight"
            aria-hidden="true"
            className="pointer-events-none absolute z-20 overflow-hidden rounded-[2px] bg-amber-300/25 text-transparent"
            style={{
              left: `${draftCommentRect.left}px`,
              top: `${draftCommentRect.top}px`,
              width: `${Math.max(draftCommentRect.width, 8)}px`,
              height: `${Math.max(draftCommentRect.height, 16)}px`
            }}
          >
            {draftCommentRect.quote}
          </span>
        )}

        {commentHighlightRects.map((rect) => (
          <button
            key={rect.id}
            type="button"
            data-comment-id={rect.id}
            data-comment-highlight="true"
            aria-label={`Comment: ${rect.quote}`}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onCommentHighlightClick?.(rect.id)
            }}
            className={cn(
              'absolute z-20 overflow-hidden rounded-[2px] bg-amber-300/35 text-transparent transition-colors hover:bg-amber-300/55',
              activeCommentId === rect.id && 'bg-amber-400/55 ring-1 ring-amber-500/70'
            )}
            style={{
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${Math.max(rect.width, 8)}px`,
              height: `${Math.max(rect.height, 16)}px`
            }}
          >
            {rect.quote}
          </button>
        ))}

        {commentTargetId && onSaveCommentRequest && (
          <CommentsRail
            targetId={commentTargetId}
            comments={comments.filter((comment) => comment.status !== 'archived')}
            commentRects={commentRailRects}
            draftAnchor={draftCommentAnchorInput}
            draftTop={draftCommentRect?.top ?? draftCommentAnchor?.y ?? null}
            activeCommentId={activeCommentId ?? null}
            onSaveDraft={handleSaveCommentDraft}
            onCancelDraft={handleCancelCommentDraft}
            onCommentClick={handleRailCommentClick}
            onUpdateComment={onUpdateCommentRequest}
            onDeleteComment={onDeleteCommentRequest}
          />
        )}

        {aiEnabled && (
          <TagSuggestionPopover
            editor={editor}
            editorContainerRef={editorContainerRef}
            onSelect={handleTagSuggestionSelect}
          />
        )}

        {wikiLinkHover.isVisible && wikiLinkHover.preview && wikiLinkHover.position && (
          <WikiLinkPreviewCard
            preview={wikiLinkHover.preview}
            position={wikiLinkHover.position}
            onMouseEnter={wikiLinkHover.handleCardMouseEnter}
            onMouseLeave={wikiLinkHover.handleCardMouseLeave}
            onTagClick={openTag}
            onNoteClick={onInternalLinkClick}
          />
        )}

        <PasteLinkMenu
          isOpen={pasteLinkState.isOpen}
          position={pasteLinkState.position}
          options={pasteLinkState.options}
          selectedIndex={pasteLinkState.selectedIndex}
          onSelect={handlePasteLinkOptionSelect}
        />
      </div>
      {marqueeZoneEl &&
        createPortal(
          <BlockMarqueeOverlay rect={marquee.marqueeRect} highlights={marquee.highlightRects} />,
          marqueeZoneEl
        )}
    </div>
  )
})

// =============================================================================
// CONTENT AREA (outer wrapper with Yjs collaboration)
// =============================================================================

export const ContentArea = memo(function ContentArea(props: ContentAreaProps) {
  const { state } = useSync()
  const syncActive =
    state.status === 'idle' || state.status === 'syncing' || state.status === 'offline'
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
