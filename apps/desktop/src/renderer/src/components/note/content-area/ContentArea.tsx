/* eslint-disable @typescript-eslint/no-explicit-any */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  SuggestionMenuController,
  useCreateBlockNote,
  FormattingToolbar,
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
import { notesService } from '@/services/notes-service'
import { useYjsCollaboration } from '@/sync/use-yjs-collaboration'
import { useSync } from '@/contexts/sync-context'
import { useWikiLinkHover } from '@/hooks/use-wiki-link-hover'
import { useAIInlineContext } from '@/contexts/ai-inline-context'
import type { ContentAreaProps } from './types'
import { WikiLinkMenu } from './wiki-link-menu'
import { TagSuggestionPopover } from './tag-suggestion-popover'
import { WikiLinkPreviewCard } from './wiki-link-preview-card'
import { BlockDropIndicator, EmptyDocumentDropIndicator } from './block-drop-indicator'
import { getCalloutSlashMenuItem } from './callout-block'
import { getTaskSlashMenuItem } from './task-block'
import { isLikelyTask } from './task-block/task-block-utils'
import { tasksService } from '@/services/tasks-service'
import { useTasksOptional } from '@/contexts/tasks'
import { parseQuickAdd } from '@/lib/quick-add-parser'
import { formatDateKey } from '@/lib/task-utils'
import { editorSchema } from './editor-schema'
import {
  HighlightReminderPopover,
  useTextSelection,
  type HighlightSelection
} from '@/components/reminder'
import { useSidebarDrillDown } from '@/contexts/sidebar-drill-down'

import {
  useBlockNoteSetup,
  useEditorDragDrop,
  useEditorFileUpload,
  useEditorSync,
  useTagSuggestions,
  useWikiLinkSuggestions,
  usePasteLinkMenu
} from './hooks'
import { PasteLinkMenu } from './paste-link-menu'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'
import { extractDomain, fetchLinkPreview } from '@/lib/url-metadata'
import { createLinkMentionContent } from './link-mention'
import type { PasteLinkOption } from './hooks/use-paste-link-menu'

const PRIORITY_REVERSE: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 }

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
  placeholder = "Start writing, or press '/' for commands...",
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
  yjsFragment,
  isRemoteUpdateRef
}: ContentAreaEditorProps) {
  const { resolvedTheme } = useTheme()
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const { openTag } = useSidebarDrillDown()
  const { port: aiPort, error: aiError, retry: retryAI } = useAIInlineContext()

  const tasksCtx = useTasksOptional()
  const [highlightSelection, setHighlightSelection] = useState<HighlightSelection | null>(null)
  const taskDetectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissedBlocksRef = useRef(new Set<string>())
  const knownTaskBlockIdsRef = useRef<Set<string>>(new Set())
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
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
      default: placeholder,
      heading: 'Heading',
      bulletListItem: 'List item',
      numberedListItem: 'List item',
      checkListItem: 'To-do item'
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
    aiPort,
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

  // Text selection for highlight reminders
  useTextSelection({
    containerRef: editorContainerRef,
    onSelectionChange: setHighlightSelection,
    minLength: 10,
    enabled: editable && !!noteId
  })

  const handleHighlightReminderCreated = useCallback(() => {
    setHighlightSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  const convertCheckboxToTask = useCallback(
    async (blockId: string, titleText: string) => {
      let projects: any[] = tasksCtx?.projects ?? []
      if (projects.length === 0) {
        const res = await tasksService.listProjects()
        projects = res.projects ?? []
      }

      const defaultProject = projects.find((p: any) => p.isDefault || p.isInbox) ?? projects[0]
      if (!defaultProject) return

      const parsed = parseQuickAdd(titleText, projects as any[])

      const block = editor.getBlock(blockId)
      if (!block) return

      try {
        const result = await tasksService.create({
          projectId: parsed.projectId ?? defaultProject.id,
          title: parsed.title,
          priority: PRIORITY_REVERSE[parsed.priority] ?? 0,
          dueDate: parsed.dueDate ? formatDateKey(parsed.dueDate) : null,
          linkedNoteIds: noteId ? [noteId] : []
        })
        if (result.success && result.task) {
          editor.updateBlock(block, {
            type: 'taskBlock' as any,
            props: { taskId: result.task.id, title: parsed.title, checked: false }
          })
          try {
            editor.setTextCursorPosition(block.id, 'end')
          } catch {
            // taskBlock has content:'none', cursor placement may not apply
          }
        }
      } catch {
        dismissedBlocksRef.current.delete(blockId)
      }
    },
    [editor, noteId, tasksCtx]
  )

  const autoCreateTaskFromCheckbox = useCallback(async () => {
    const extractText = (content: any): string => {
      if (!content) return ''
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content.map((c: any) => (typeof c === 'string' ? c : (c.text ?? ''))).join('')
    }

    const scanBlocks = (blocks: any[]): void => {
      for (const block of blocks) {
        if (block.type === 'checkListItem' && !dismissedBlocksRef.current.has(block.id)) {
          const text = extractText(block.content)
          if (text.trim()) {
            dismissedBlocksRef.current.add(block.id)
            void convertCheckboxToTask(block.id, text.trim())
            return
          }
        }
        if (block.children?.length) {
          scanBlocks(block.children)
        }
      }
    }

    scanBlocks(editor.document as any[])
  }, [editor, convertCheckboxToTask])

  const handleEditorContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      const checkListBlock = target.closest('[data-content-type="checkListItem"]')
      if (!checkListBlock) return

      const blockId = checkListBlock.getAttribute('data-id')
      if (!blockId) return

      const block = editor.getBlock(blockId)
      if (!block || block.type !== 'checkListItem') return

      const content = block.content as any[]
      const text =
        content?.map((c: any) => (typeof c === 'string' ? c : (c.text ?? ''))).join('') ?? ''
      if (!text.trim()) return

      e.preventDefault()
      dismissedBlocksRef.current.add(blockId)
      await convertCheckboxToTask(blockId, text.trim())
    },
    [editor, convertCheckboxToTask]
  )

  useEffect(() => {
    return () => {
      if (taskDetectTimeoutRef.current) clearTimeout(taskDetectTimeoutRef.current)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Note editor"
      className={cn('content-area h-full flex flex-col relative', className)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && dropTarget && (
        <BlockDropIndicator dropTarget={dropTarget} containerRef={containerRef} />
      )}
      {isDragging && !dropTarget && <EmptyDocumentDropIndicator />}

      {aiError && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/40">
          <span className="truncate">{aiError}</span>
          <button onClick={retryAI} className="shrink-0 underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      <div
        ref={editorContainerRef}
        className={cn(
          'bn-container flex-1 min-h-[300px] relative',
          stickyToolbar && 'sticky-toolbar-enabled'
        )}
        role="application"
        aria-label="Rich text editor"
        onContextMenu={handleEditorContextMenu}
      >
        <BlockNoteView
          editor={editor}
          editable={editable}
          onChange={(): void => {
            void handleChange()
            if (taskDetectTimeoutRef.current) clearTimeout(taskDetectTimeoutRef.current)
            taskDetectTimeoutRef.current = setTimeout(() => void autoCreateTaskFromCheckbox(), 800)

            const currentTaskIds = new Set<string>()
            const scanTaskIds = (blocks: any[]): void => {
              for (const b of blocks) {
                if (b.type === 'taskBlock' && b.props?.taskId) {
                  currentTaskIds.add(b.props.taskId as string)
                }
                if (b.children?.length) scanTaskIds(b.children)
              }
            }
            scanTaskIds(editor.document as any[])

            for (const prevId of knownTaskBlockIdsRef.current) {
              if (!currentTaskIds.has(prevId)) {
                void tasksService.delete(prevId)
              }
            }
            knownTaskBlockIdsRef.current = currentTaskIds
          }}
          theme={editorTheme}
          formattingToolbar={!stickyToolbar}
          slashMenu={false}
        >
          {stickyToolbar && <FormattingToolbar />}
          {aiReady && <AIMenuController aiMenu={CustomAIMenu} />}
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={async (query) => {
              const defaults = getDefaultReactSlashMenuItems(editor)
              const aiItems = aiReady ? getAISlashMenuItems(editor) : []
              const calloutItem = getCalloutSlashMenuItem(editor)
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
            onItemClick={handleWikiLinkSelect}
          />
        </BlockNoteView>

        <TagSuggestionPopover
          editor={editor}
          editorContainerRef={editorContainerRef}
          onSelect={handleTagSuggestionSelect}
        />

        {noteId && highlightSelection && (
          <HighlightReminderPopover
            noteId={noteId}
            selection={highlightSelection}
            onClose={() => setHighlightSelection(null)}
            onReminderCreated={handleHighlightReminderCreated}
            containerRef={editorContainerRef}
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
    </div>
  )
})

// =============================================================================
// CONTENT AREA (outer wrapper with Yjs collaboration)
// =============================================================================

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
