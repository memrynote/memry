/**
 * NotePage Component
 *
 * Displays and edits a note from the vault.
 * Loads real note data via useNotes() hook and saves changes via updateNote().
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ExportDialog } from '@/components/note/export-dialog'
import { VersionHistory } from '@/components/note/version-history'
import { EditorErrorBoundary } from '@/components/note/editor-error-boundary'
import { NoteLayout, HeadingItem, ContentArea, HeadingInfo, Block } from '@/components/note'
import { NoteTitle } from '@/components/note/note-title'
import { TagsRow, Tag } from '@/components/note/tags-row'
import { InfoSection } from '@/components/note/info-section'
import { BacklinksSection, Backlink } from '@/components/note/backlinks'
import { LinkedTasksSection } from '@/components/note/linked-tasks'
import {
  useNote,
  useNoteMutations,
  useNoteLinksQuery,
  useNoteTagsQuery,
  type Note
} from '@/hooks/use-notes-query'
import { usePropertySection, type PropertySectionAction } from '@/hooks/use-property-section'
import { useTasksLinkedToNote } from '@/hooks/use-tasks-linked-to-note'
import { notesService, onNoteDeleted, onNoteUpdated, onNoteRenamed } from '@/services/notes-service'
import { resolveWikiLink } from '@/lib/wikilink-resolver'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { MoreHorizontal, History, Bookmark, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { useIsBookmarked } from '@/hooks/use-bookmarks'
import { NoteReminderButton } from '@/components/note/note-reminder-button'
import { useNoteEditorSettings } from '@/hooks/use-note-editor-settings'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('Page:Note')

// ============================================================================
// Types
// ============================================================================

interface NotePageProps {
  noteId?: string
}

// ============================================================================
// Error State Component
// ============================================================================

function NoteErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-destructive font-medium">Failed to load note</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        {onRetry && (
          <button onClick={onRetry} className="text-sm text-primary hover:underline">
            Try again
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Empty State Component
// ============================================================================

function NoteEmptyState() {
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
        <p className="text-sm">No note selected</p>
        <p className="text-xs">Select a note from the sidebar to view it</p>
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function NotePage({ noteId }: NotePageProps) {
  // TanStack Query hooks for data fetching with caching
  const { note, isLoading, error: noteError, refetch: refetchNote } = useNote(noteId ?? null)
  const { createNote, updateNote, renameNote } = useNoteMutations()
  const { incoming: rawBacklinks, isLoading: backlinksLoading } = useNoteLinksQuery(noteId ?? null)
  const { tasks: linkedTasks, isLoading: linkedTasksLoading } = useTasksLinkedToNote(noteId ?? null)
  const { tags: allAvailableTags } = useNoteTagsQuery()
  const { openTab, setTabDeleted, updateTabTitleByEntityId } = useTabs()
  const activeTab = useActiveTab()
  const queryClient = useQueryClient()

  // Extract highlight info from tab viewState (from reminder navigation)
  const initialHighlight = useMemo(() => {
    const viewState = activeTab?.viewState as
      | {
          highlightStart?: number
          highlightEnd?: number
          highlightText?: string
        }
      | undefined

    if (viewState?.highlightText) {
      return {
        text: viewState.highlightText,
        start: viewState.highlightStart,
        end: viewState.highlightEnd
      }
    }
    return undefined
  }, [activeTab?.viewState])

  // Convert query error to string
  const error = noteError?.message ?? null

  // Local state (UI-only, not data loading)
  const [headings, setHeadings] = useState<HeadingItem[]>([])
  const [isInfoExpanded, setIsInfoExpanded] = useState(false)
  const [isDeleted, setIsDeleted] = useState(false)
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false)
  const [externalUpdateCount, setExternalUpdateCount] = useState(0)

  const handlePropertyBlocked = useCallback((action: PropertySectionAction) => {
    const messages: Record<PropertySectionAction, string> = {
      update: 'Cannot update property - this note was deleted',
      add: 'Cannot add property - this note was deleted',
      remove: 'Cannot delete property - this note was deleted',
      rename: 'Cannot rename property - this note was deleted',
      reorder: 'Cannot reorder properties - this note was deleted'
    }
    toast.error(messages[action])
  }, [])

  const {
    properties,
    handlePropertyChange,
    handleAddProperty,
    handleDeleteProperty,
    handlePropertyNameChange,
    handlePropertyOrderChange
  } = usePropertySection({
    entityId: noteId ?? null,
    canEdit: () => !isDeleted,
    onBlocked: handlePropertyBlocked,
    includeExplicitType: true
  })

  // Bookmark state
  const { isBookmarked, toggle: toggleBookmark } = useIsBookmarked('note', noteId ?? '')

  // Editor settings (toolbar mode)
  const { settings: editorSettings } = useNoteEditorSettings()

  // Content tracking for change detection
  const lastSavedContent = useRef<string>('')

  // Refs for debouncing
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingMarkdownRef = useRef<string | null>(null)

  // Compute document stats for the Info tab in OutlineInfoPanel
  const documentStats = useMemo(() => {
    if (!note) return undefined
    return {
      wordCount: note.wordCount ?? 0,
      characterCount: note.content?.length ?? 0,
      createdAt: note.created ?? null,
      modifiedAt: note.modified ?? null
    }
  }, [note])

  // ============================================================================
  // Sync lastSavedContent with note data from query
  // ============================================================================

  // Update lastSavedContent when note data changes (from cache or fresh fetch)
  useEffect(() => {
    if (note?.content) {
      lastSavedContent.current = note.content
    }
    // Reset deleted state when switching to a new note
    setIsDeleted(false)
  }, [note?.id, note?.content])

  // Stable ref so cleanup can always call the latest mutateAsync
  const updateNoteRef = useRef(updateNote.mutateAsync)
  updateNoteRef.current = updateNote.mutateAsync

  // Register with save registry + flush on unmount
  useEffect(() => {
    if (!noteId) return

    const registryKey = `note-page:${noteId}`

    registerPendingSave(registryKey, async () => {
      const pending = pendingMarkdownRef.current
      if (pending !== null) {
        pendingMarkdownRef.current = null
        await updateNoteRef.current({ id: noteId, content: pending })
      }
    })

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }

      const pending = pendingMarkdownRef.current
      if (pending !== null) {
        pendingMarkdownRef.current = null
        void updateNoteRef.current({ id: noteId, content: pending })
      }

      unregisterPendingSave(registryKey)
    }
  }, [noteId])

  // Listen for note deletion events
  useEffect(() => {
    if (!noteId) return

    const handleDeleted = (event: { id: string }) => {
      if (event.id === noteId) {
        setIsDeleted(true)
        // Mark tab as deleted with strikethrough (using entityId)
        setTabDeleted(noteId, true)
      }
    }

    const unsubDeleted = onNoteDeleted(handleDeleted)

    return () => {
      unsubDeleted()
    }
  }, [noteId, setTabDeleted])

  // Listen for sync-driven rename events to update tab title
  useEffect(() => {
    if (!noteId) return

    const unsub = onNoteRenamed((event) => {
      if (event.id === noteId) {
        updateTabTitleByEntityId(noteId, event.newTitle)
      }
    })

    return unsub
  }, [noteId, updateTabTitleByEntityId])

  // Listen for external note updates (file changed outside app)
  // Track if we're currently saving to ignore our own updates
  const isSavingRef = useRef(false)

  useEffect(() => {
    if (!noteId) return

    const handleUpdated = (event: { id: string; changes: Partial<Note>; source?: string }) => {
      // Only handle external updates for this note
      if (event.id !== noteId) return
      // Ignore our own saves (source won't be 'external')
      if (event.source !== 'external') return
      // Ignore if we're currently saving
      if (isSavingRef.current) return

      // TanStack Query will handle the cache invalidation and refetch.
      // We just need to update lastSavedContent and force editor remount.
      if (event.changes.content !== undefined) {
        lastSavedContent.current = event.changes.content
      }

      // Increment counter to force editor remount with new content
      setExternalUpdateCount((c) => c + 1)
    }

    const unsubUpdated = onNoteUpdated(handleUpdated)

    return () => {
      unsubUpdated()
    }
  }, [noteId])

  // ============================================================================
  // Tags - Convert between string[] and Tag[]
  // ============================================================================

  // Build a lookup map of tag colors from backend
  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of allAvailableTags) {
      map.set(t.tag, t.color)
    }
    return map
  }, [allAvailableTags])

  const noteTags: Tag[] = useMemo(() => {
    return (note?.tags || []).map((tagName) => ({
      id: tagName,
      name: tagName,
      color: tagColorMap.get(tagName) ?? 'stone' // Fallback to stone if not found
    }))
  }, [note?.tags, tagColorMap])

  const availableTags: Tag[] = useMemo(() => {
    return allAvailableTags.map((t) => ({
      id: t.tag,
      name: t.tag,
      color: t.color // Use color from backend
    }))
  }, [allAvailableTags])

  const recentTags = useMemo(() => {
    return availableTags.slice(0, 4)
  }, [availableTags])

  // ============================================================================
  // Backlinks - Convert to UI format
  // ============================================================================

  const backlinks: Backlink[] = useMemo(() => {
    return rawBacklinks.map((bl) => {
      const pathParts = bl.sourcePath.split('/')
      const withoutNotesPrefix = pathParts[0] === 'notes' ? pathParts.slice(1) : pathParts
      const folderPath = withoutNotesPrefix.slice(0, -1).join('/')

      return {
        id: bl.sourceId,
        noteId: bl.sourceId,
        noteTitle: bl.sourceTitle,
        folder: folderPath,
        date: new Date(),
        mentions: bl.context
          ? [
              {
                id: `mention-${bl.sourceId}`,
                snippet: bl.context,
                linkStart: 0,
                linkEnd: 0
              }
            ]
          : []
      }
    })
  }, [rawBacklinks])

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleHeadingClick = useCallback((headingId: string) => {
    const element = document.querySelector(`[data-id="${headingId}"]`)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  const handleHeadingsChange = useCallback((newHeadings: HeadingInfo[]) => {
    setHeadings(
      newHeadings.map((h) => ({
        id: h.id,
        level: h.level,
        text: h.text,
        position: h.position
      }))
    )
  }, [])

  // Debounced save on markdown content change
  const handleMarkdownChange = useCallback(
    (markdown: string) => {
      if (!noteId || !note) return

      // Block saves if note was deleted
      if (isDeleted) {
        toast.error('Cannot save - this note was deleted')
        return
      }

      // Skip if content hasn't changed
      if (markdown === lastSavedContent.current) return

      pendingMarkdownRef.current = markdown

      // Clear previous timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }

      // Debounce save (500ms)
      saveTimeoutRef.current = setTimeout(async () => {
        isSavingRef.current = true
        try {
          await updateNote.mutateAsync({ id: noteId, content: markdown })
          lastSavedContent.current = markdown
          pendingMarkdownRef.current = null
        } catch (err) {
          log.error('Failed to save note:', err)
        } finally {
          isSavingRef.current = false
        }
      }, 500)
    },
    [noteId, note, updateNote.mutateAsync, isDeleted]
  )

  const handleContentChange = useCallback((_blocks: Block[]) => {
    // Content change is handled via onMarkdownChange
  }, [])

  const handleTitleChange = useCallback(
    async (newTitle: string) => {
      if (!noteId || !note || newTitle === note.title) return

      if (isDeleted) {
        toast.error('Cannot rename - this note was deleted')
        return
      }

      try {
        await renameNote.mutateAsync({ id: noteId, newTitle })
        // Note will be updated via TanStack Query cache invalidation
      } catch (err) {
        log.error('Failed to rename note:', err)
      }
    },
    [noteId, note, renameNote.mutateAsync, isDeleted]
  )

  // T026: Handle emoji changes - save to backend
  const handleEmojiChange = useCallback(
    async (newEmoji: string | null) => {
      if (!noteId || !note) return

      if (isDeleted) {
        toast.error('Cannot update emoji - this note was deleted')
        return
      }

      try {
        await updateNote.mutateAsync({ id: noteId, emoji: newEmoji })
        // Note will be updated via TanStack Query cache invalidation
      } catch (err) {
        log.error('Failed to update emoji:', err)
        toast.error('Failed to update emoji')
      }
    },
    [noteId, note, updateNote.mutateAsync, isDeleted]
  )

  // Tag handlers
  const handleAddTag = useCallback(
    async (tagId: string) => {
      if (!noteId || !note) return

      if (isDeleted) {
        toast.error('Cannot add tag - this note was deleted')
        return
      }

      const tagToAdd = availableTags.find((t) => t.id === tagId)
      if (tagToAdd && !note.tags.includes(tagToAdd.name)) {
        const newTags = [...note.tags, tagToAdd.name]
        try {
          await updateNote.mutateAsync({ id: noteId, tags: newTags })
          // Note will be updated via TanStack Query cache invalidation
        } catch (err) {
          log.error('Failed to add tag:', err)
        }
      }
    },
    [noteId, note, availableTags, updateNote.mutateAsync, isDeleted]
  )

  const handleCreateTag = useCallback(
    async (name: string, _color: string) => {
      if (!noteId || !note) return

      if (isDeleted) {
        toast.error('Cannot add tag - this note was deleted')
        return
      }

      if (!note.tags.includes(name)) {
        const newTags = [...note.tags, name]
        try {
          await updateNote.mutateAsync({ id: noteId, tags: newTags })
          // Note will be updated via TanStack Query cache invalidation
        } catch (err) {
          log.error('Failed to create tag:', err)
        }
      }
    },
    [noteId, note, updateNote.mutateAsync, isDeleted]
  )

  const handleRemoveTag = useCallback(
    async (tagId: string) => {
      if (!noteId || !note) return

      if (isDeleted) {
        toast.error('Cannot remove tag - this note was deleted')
        return
      }

      const newTags = note.tags.filter((t) => t !== tagId)
      try {
        await updateNote.mutateAsync({ id: noteId, tags: newTags })
        // Note will be updated via TanStack Query cache invalidation
      } catch (err) {
        log.error('Failed to remove tag:', err)
      }
    },
    [noteId, note, updateNote.mutateAsync, isDeleted]
  )

  // Local-only toggle
  const handleToggleLocalOnly = useCallback(
    async (value: boolean) => {
      if (!noteId) return
      if (isDeleted) {
        toast.error('Cannot change local-only — this note was deleted')
        return
      }
      try {
        await notesService.setLocalOnly(noteId, value)
        refetchNote()
        queryClient.invalidateQueries({ queryKey: ['notes', 'localOnlyCount'] })
        toast.success(value ? 'Note set to local only' : 'Note will sync to cloud')
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to toggle local only'))
      }
    },
    [noteId, isDeleted, refetchNote, queryClient]
  )

  // Link handlers
  const handleLinkClick = useCallback((href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])

  const handleInternalLinkClick = useCallback(
    async (linkedNoteIdOrTitle: string) => {
      const target = linkedNoteIdOrTitle?.trim()
      if (!target) return

      try {
        // Use format-aware resolution to handle notes and files
        const resolution = await resolveWikiLink(target)

        switch (resolution.type) {
          case 'file':
            // Open file in appropriate viewer (image, video, PDF, audio)
            openTab({
              type: 'file',
              title: resolution.title,
              icon: resolution.icon,
              path: `/file/${resolution.id}`,
              entityId: resolution.id,
              isPinned: false,
              isModified: false,
              isPreview: false,
              isDeleted: false
            })
            break

          case 'note':
            // Open note in editor
            openTab({
              type: 'note',
              title: resolution.title,
              icon: 'file-text',
              path: `/notes/${resolution.id}`,
              entityId: resolution.id,
              isPinned: false,
              isModified: false,
              isPreview: true,
              isDeleted: false
            })
            break

          case 'create':
            // Create new note with this title
            const result = await createNote.mutateAsync({ title: target })
            if (!result.success || !result.note) {
              toast.error('Failed to create linked note')
              return
            }
            openTab({
              type: 'note',
              title: result.note.title,
              icon: 'file-text',
              path: `/notes/${result.note.id}`,
              entityId: result.note.id,
              isPinned: false,
              isModified: false,
              isPreview: true,
              isDeleted: false
            })
            break

          case 'not-found':
            // File-like target not found - show error instead of creating a note
            toast.error(`File not found: ${target}`)
            break
        }
      } catch (err) {
        log.error('Failed to resolve wiki link:', err)
        toast.error('Failed to open linked item')
      }
    },
    [openTab, createNote.mutateAsync]
  )

  const handleBacklinkClick = useCallback(
    (backlinkNoteId: string) => {
      // Look up the title from the backlinks array
      const backlink = backlinks.find((bl) => bl.noteId === backlinkNoteId)
      const noteTitle = backlink?.noteTitle || 'Note'

      openTab({
        type: 'note',
        title: noteTitle,
        icon: 'file-text',
        path: `/notes/${backlinkNoteId}`,
        entityId: backlinkNoteId,
        isPinned: false,
        isModified: false,
        isPreview: true,
        isDeleted: false
      })
    },
    [openTab, backlinks]
  )

  // Handle clicking on a linked task
  const handleLinkedTaskClick = useCallback(
    (taskId: string) => {
      openTab({
        type: 'tasks',
        title: 'Tasks',
        icon: 'check-square',
        path: `/tasks?taskId=${taskId}`,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  // ============================================================================
  // Render
  // ============================================================================

  // No note ID - show empty state
  if (!noteId) {
    return <NoteEmptyState />
  }

  // Error
  if (error) {
    return <NoteErrorState error={error} onRetry={refetchNote} />
  }

  // Loading state - show nothing while fetching to avoid flash of error
  if (isLoading || !note) {
    return null
  }

  return (
    <NoteLayout headings={headings} onHeadingClick={handleHeadingClick} stats={documentStats}>
      {/* Note content wrapper with relative positioning for action bar */}
      <div className="relative">
        {/* Action bar - positioned at top-right of content area */}
        <div className="absolute top-0 right-0 z-10 flex items-center gap-2">
          {/* Reminder Button */}
          {noteId && <NoteReminderButton noteId={noteId} disabled={isDeleted} />}

          {/* Bookmark Button */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-muted/50"
            onClick={toggleBookmark}
            disabled={isDeleted || !noteId}
            title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
          >
            <Bookmark className={`h-4 w-4 ${isBookmarked ? 'fill-current text-amber-500' : ''}`} />
            <span className="sr-only">{isBookmarked ? 'Remove bookmark' : 'Add bookmark'}</span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-muted/50"
                disabled={isDeleted}
              >
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setIsVersionHistoryOpen(true)}>
                <History className="mr-2 h-4 w-4" />
                Version History
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsExportDialogOpen(true)}>
                Export
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handleToggleLocalOnly(!(note.frontmatter.localOnly ?? false))}
              >
                <Monitor className="mr-2 h-4 w-4" />
                {note.frontmatter.localOnly ? 'Disable local only' : 'Set local only'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Note content */}
        <div className="space-y-8">
          <div style={{ paddingInline: '54px' }}>
            {/* Title section */}
            <div className="space-y-4">
              <div className="relative">
                <div
                  className="absolute -left-8 top-1/2 -translate-y-1/2 w-1 h-12 bg-gradient-to-b from-amber-400/40 via-amber-500/20 to-transparent rounded-full opacity-60"
                  aria-hidden="true"
                />
                <NoteTitle
                  emoji={note.emoji ?? null}
                  title={note.title}
                  onEmojiChange={handleEmojiChange}
                  onTitleChange={handleTitleChange}
                  placeholder="Untitled"
                />
              </div>
            </div>

            {/* Tags section */}
            <div>
              <TagsRow
                tags={noteTags}
                availableTags={availableTags}
                recentTags={recentTags}
                onAddTag={handleAddTag}
                onCreateTag={handleCreateTag}
                onRemoveTag={handleRemoveTag}
              />
            </div>

            {/* Info Section (Properties) - always show for adding new properties */}
            <div>
              <InfoSection
                properties={properties}
                isExpanded={isInfoExpanded}
                onToggleExpand={() => setIsInfoExpanded(!isInfoExpanded)}
                onPropertyChange={handlePropertyChange}
                onPropertyNameChange={handlePropertyNameChange}
                onPropertyOrderChange={handlePropertyOrderChange}
                onAddProperty={handleAddProperty}
                onDeleteProperty={handleDeleteProperty}
                disabled={isDeleted}
              />
            </div>
          </div>

          {/* Main content - BlockNote Editor with Markdown */}
          <div
            role="presentation"
            className="editor-click-area min-h-[400px] relative"
            onMouseDown={(e) => {
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
              const editor = (e.currentTarget as HTMLElement).querySelector(
                '.bn-editor [contenteditable="true"]'
              ) as HTMLElement
              if (editor) {
                e.preventDefault()
                editor.focus()
              }
            }}
          >
            <EditorErrorBoundary
              noteId={noteId}
              onRecover={refetchNote}
              onError={(error) => log.error('Editor error:', error)}
            >
              <ContentArea
                key={`${noteId}-${externalUpdateCount}`}
                noteId={noteId}
                initialContent={note.content}
                contentType="markdown"
                placeholder="Start writing, or press '/' for commands..."
                stickyToolbar={editorSettings.toolbarMode === 'sticky'}
                onContentChange={handleContentChange}
                onMarkdownChange={handleMarkdownChange}
                onHeadingsChange={handleHeadingsChange}
                onLinkClick={handleLinkClick}
                onInternalLinkClick={handleInternalLinkClick}
                initialHighlight={initialHighlight}
              />
            </EditorErrorBoundary>
          </div>

          {/* Backlinks section */}
          <div className="pt-8 mx-[54px] border-t border-border/30">
            <BacklinksSection
              backlinks={backlinks}
              isLoading={backlinksLoading}
              initialCount={5}
              collapsible={true}
              onBacklinkClick={handleBacklinkClick}
            />

            {/* Linked Tasks Section */}
            <LinkedTasksSection
              tasks={linkedTasks}
              isLoading={linkedTasksLoading}
              onTaskClick={handleLinkedTaskClick}
            />
          </div>
        </div>
      </div>

      {/* Export Dialog */}
      <ExportDialog
        open={isExportDialogOpen}
        onOpenChange={setIsExportDialogOpen}
        noteId={noteId}
        noteTitle={note.title}
      />

      {/* Version History Panel */}
      <VersionHistory
        open={isVersionHistoryOpen}
        onOpenChange={setIsVersionHistoryOpen}
        noteId={noteId}
        noteTitle={note.title}
        onRestore={() => {
          // Clear any pending save to prevent overwriting restored content
          if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current)
            saveTimeoutRef.current = null
          }
          // Reload note with restored content
          refetchNote()
        }}
      />
    </NoteLayout>
  )
}
