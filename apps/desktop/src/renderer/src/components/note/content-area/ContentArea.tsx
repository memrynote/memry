/* eslint-disable @typescript-eslint/no-explicit-any */

import { createPortal } from 'react-dom'
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
import { tasksService } from '@/services/tasks-service'
import { useTasksOptional } from '@/contexts/tasks'
import { parseQuickAdd } from '@/lib/quick-add-parser'
import { formatDateKey } from '@/lib/task-utils'
import { editorSchema } from './editor-schema'
import { analyzeTaskIntents } from './scan-task-intents'
import {
  HighlightReminderPopover,
  useTextSelection,
  type HighlightSelection
} from '@/components/reminder'
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
  isRemoteUpdateRef,
  marqueeZoneEl
}: ContentAreaEditorProps) {
  const { resolvedTheme } = useTheme()
  const editorTheme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const { openTag } = useSidebarDrillDown()
  const { port: aiPort, error: aiError, retry: retryAI } = useAIInlineContext()

  const tasksCtx = useTasksOptional()
  const [highlightSelection, setHighlightSelection] = useState<HighlightSelection | null>(null)
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

  const [innerContainerEl, setInnerContainerEl] = useState<HTMLDivElement | null>(null)
  const setEditorContainerRef = useCallback((el: HTMLDivElement | null) => {
    editorContainerRef.current = el
    setInnerContainerEl(el)
  }, [])

  // State (not just editorContainerRef) so the marquee hook's useEffect
  // re-runs when .bn-container first mounts — refs don't trigger effects.
  const triggerEl = marqueeZoneEl ?? innerContainerEl

  // Finder-style multi-block marquee selection
  const marquee = useBlockMarqueeSelection({
    editor,
    blockContainerRef: editorContainerRef,
    triggerContainerEl: triggerEl,
    enabled: editable
  })

  const handleHighlightReminderCreated = useCallback(() => {
    setHighlightSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

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
        ref={setEditorContainerRef}
        className={cn(
          'bn-container flex-1 min-h-[300px] relative',
          stickyToolbar && 'sticky-toolbar-enabled'
        )}
        role="application"
        aria-label="Rich text editor"
        onContextMenu={handleEditorContextMenu}
      >
        {!marqueeZoneEl && (
          <BlockMarqueeOverlay rect={marquee.marqueeRect} highlights={marquee.highlightRects} />
        )}
        <BlockNoteView
          editor={editor}
          editable={editable}
          onChange={(): void => {
            void handleChange()

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

        {editable && noteId && highlightSelection && (
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
