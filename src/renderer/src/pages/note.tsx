/**
 * NotePage Component
 *
 * Displays and edits a note from the vault.
 * Loads real note data via useNotes() hook and saves changes via updateNote().
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { ExportDialog } from '@/components/note/export-dialog'
import { VersionHistory } from '@/components/note/version-history'
import { EditorErrorBoundary } from '@/components/note/editor-error-boundary'
import { NoteLayout, HeadingItem, ContentArea, HeadingInfo, Block } from '@/components/note'
import { NoteTitle } from '@/components/note/note-title'
import { TagsRow, Tag } from '@/components/note/tags-row'
import { InfoSection, Property, NewProperty, PropertyType } from '@/components/note/info-section'
import { BacklinksSection, Backlink } from '@/components/note/backlinks'
import { LinkedTasksSection } from '@/components/note/linked-tasks'
import { useNotes, useNoteLinks, useNoteTags, type Note } from '@/hooks/use-notes'
import { useNoteProperties } from '@/hooks/use-note-properties'
import { useTasksLinkedToNote } from '@/hooks/use-tasks-linked-to-note'
import { notesService, onNoteDeleted, onNoteUpdated } from '@/services/notes-service'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { MoreHorizontal, History, Bookmark } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { useIsBookmarked } from '@/hooks/use-bookmarks'
import { NoteReminderButton } from '@/components/note/note-reminder-button'

// ============================================================================
// Types
// ============================================================================

interface NotePageProps {
  noteId?: string
}

// Default values for property types when creating new properties
function getDefaultValueForType(type: PropertyType): unknown {
  switch (type) {
    case 'checkbox':
      return false
    case 'number':
    case 'rating':
      return 0
    case 'multiSelect':
      return []
    case 'date':
      return null
    default:
      return ''
  }
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
  // Hooks for data fetching
  const { createNote, getNote, updateNote, renameNote } = useNotes({ autoLoad: false })
  const { incoming: rawBacklinks, isLoading: backlinksLoading } = useNoteLinks(noteId ?? null)
  const { tasks: linkedTasks, isLoading: linkedTasksLoading } = useTasksLinkedToNote(noteId ?? null)
  const { tags: allAvailableTags } = useNoteTags()
  const { openTab, setTabDeleted } = useTabs()
  const activeTab = useActiveTab()

  // Extract highlight info from tab viewState (from reminder navigation)
  const initialHighlight = useMemo(() => {
    const viewState = activeTab?.viewState as {
      highlightStart?: number
      highlightEnd?: number
      highlightText?: string
    } | undefined

    if (viewState?.highlightText) {
      return {
        text: viewState.highlightText,
        start: viewState.highlightStart,
        end: viewState.highlightEnd
      }
    }
    return undefined
  }, [activeTab?.viewState])

  // Properties from backend
  const {
    properties: backendProperties,
    updateProperty: updateBackendProperty,
    addProperty: addBackendProperty,
    removeProperty: removeBackendProperty
  } = useNoteProperties(noteId ?? null)

  // Bookmark state
  const { isBookmarked, toggle: toggleBookmark } = useIsBookmarked('note', noteId ?? '')

  // Local state
  const [note, setNote] = useState<Note | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [headings, setHeadings] = useState<HeadingItem[]>([])
  const [isInfoExpanded, setIsInfoExpanded] = useState(false)
  const [isDeleted, setIsDeleted] = useState(false)
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false)
  const [externalUpdateCount, setExternalUpdateCount] = useState(0)

  // Content tracking for change detection
  const lastSavedContent = useRef<string>('')

  // Refs for debouncing
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Type mapping for backend PropertyValue → UI Property
  const mapPropertyType = useCallback((backendType: string): PropertyType => {
    const typeMap: Record<string, PropertyType> = {
      text: 'text',
      number: 'number',
      checkbox: 'checkbox',
      date: 'date',
      select: 'select',
      multiselect: 'multiSelect',
      url: 'url',
      rating: 'rating'
    }
    return typeMap[backendType] ?? 'text'
  }, [])

  // Convert backend properties to UI format
  const properties: Property[] = useMemo(() => {
    return backendProperties.map((prop) => ({
      id: prop.name,
      name: prop.name,
      type: mapPropertyType(prop.type),
      value: prop.value,
      isCustom: true
    }))
  }, [backendProperties, mapPropertyType])

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
  // Load Note
  // ============================================================================

  const loadNote = useCallback(async () => {
    if (!noteId) {
      setNote(null)
      return
    }

    setError(null)
    setIsDeleted(false) // Reset deleted state when loading a new note

    try {
      const loadedNote = await getNote(noteId)
      if (loadedNote) {
        setNote(loadedNote)
        lastSavedContent.current = loadedNote.content
        // Properties are now loaded via useNoteProperties hook
      } else {
        setError('Note not found')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load note')
    }
  }, [noteId, getNote])

  // Load note when noteId changes
  useEffect(() => {
    loadNote()
  }, [loadNote])

  // Cleanup save timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [])

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

      // Update local state with new content from external change
      setNote((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          ...event.changes,
          content: event.changes.content ?? prev.content
        }
      })

      // Update lastSavedContent to prevent false dirty detection
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
    return rawBacklinks.map((bl) => ({
      id: bl.sourceId,
      noteId: bl.sourceId,
      noteTitle: bl.sourceTitle,
      folder: bl.sourcePath.split('/')[0] || '',
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
    }))
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

      // Clear previous timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }

      // Debounce save (500ms)
      saveTimeoutRef.current = setTimeout(async () => {
        isSavingRef.current = true
        try {
          await updateNote({ id: noteId, content: markdown })
          lastSavedContent.current = markdown
        } catch (err) {
          console.error('Failed to save note:', err)
        } finally {
          isSavingRef.current = false
        }
      }, 500)
    },
    [noteId, note, updateNote, isDeleted]
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
        const result = await renameNote(noteId, newTitle)
        if (result) {
          setNote(result)
        }
      } catch (err) {
        console.error('Failed to rename note:', err)
      }
    },
    [noteId, note, renameNote, isDeleted]
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
        const result = await updateNote({ id: noteId, emoji: newEmoji })
        if (result) {
          setNote(result)
        }
      } catch (err) {
        console.error('Failed to update emoji:', err)
        toast.error('Failed to update emoji')
      }
    },
    [noteId, note, updateNote, isDeleted]
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
          const result = await updateNote({ id: noteId, tags: newTags })
          if (result) {
            setNote(result)
          }
        } catch (err) {
          console.error('Failed to add tag:', err)
        }
      }
    },
    [noteId, note, availableTags, updateNote, isDeleted]
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
          const result = await updateNote({ id: noteId, tags: newTags })
          if (result) {
            setNote(result)
          }
        } catch (err) {
          console.error('Failed to create tag:', err)
        }
      }
    },
    [noteId, note, updateNote, isDeleted]
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
        const result = await updateNote({ id: noteId, tags: newTags })
        if (result) {
          setNote(result)
        }
      } catch (err) {
        console.error('Failed to remove tag:', err)
      }
    },
    [noteId, note, updateNote, isDeleted]
  )

  // Property handlers - wired to backend
  const handlePropertyChange = useCallback(
    async (propertyId: string, value: unknown) => {
      console.log('[NotePage] handlePropertyChange called:', { propertyId, value, noteId })
      if (isDeleted) {
        toast.error('Cannot update property - this note was deleted')
        return
      }
      try {
        await updateBackendProperty(propertyId, value)
        console.log('[NotePage] Property updated successfully')
      } catch (err) {
        console.error('[NotePage] Failed to update property:', err)
        toast.error('Failed to update property')
      }
    },
    [updateBackendProperty, isDeleted, noteId]
  )

  const handleAddProperty = useCallback(
    async (newProp: NewProperty) => {
      console.log('[NotePage] handleAddProperty called:', { newProp, noteId })
      if (isDeleted) {
        toast.error('Cannot add property - this note was deleted')
        return
      }
      // Get default value based on type
      const defaultValue = getDefaultValueForType(newProp.type)
      console.log('[NotePage] Adding property with default value:', {
        name: newProp.name,
        defaultValue
      })
      try {
        await addBackendProperty(newProp.name, defaultValue)
        console.log('[NotePage] Property added successfully')
      } catch (err) {
        console.error('[NotePage] Failed to add property:', err)
        toast.error('Failed to add property')
      }
    },
    [addBackendProperty, isDeleted, noteId]
  )

  const handleDeleteProperty = useCallback(
    async (propertyId: string) => {
      console.log('[NotePage] handleDeleteProperty called:', { propertyId, noteId })
      if (isDeleted) {
        toast.error('Cannot delete property - this note was deleted')
        return
      }
      try {
        await removeBackendProperty(propertyId)
        console.log('[NotePage] Property deleted successfully')
      } catch (err) {
        console.error('[NotePage] Failed to delete property:', err)
        toast.error('Failed to delete property')
      }
    },
    [removeBackendProperty, isDeleted, noteId]
  )

  // Link handlers
  const handleLinkClick = useCallback((href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])

  const handleInternalLinkClick = useCallback(
    async (linkedNoteIdOrTitle: string) => {
      const target = linkedNoteIdOrTitle?.trim()
      if (!target) return

      let resolvedId = target
      let resolvedTitle = 'Note'

      try {
        const byId = await getNote(target)
        if (byId) {
          resolvedId = byId.id
          resolvedTitle = byId.title
        } else {
          const listResult = await notesService.list({ sortBy: 'title', limit: 500 })
          const match = listResult.notes.find(
            (note) => note.title.toLowerCase() === target.toLowerCase()
          )

          if (match) {
            resolvedId = match.id
            resolvedTitle = match.title
          } else {
            const created = await createNote({ title: target })
            if (!created) {
              toast.error('Failed to create linked note')
              return
            }
            resolvedId = created.id
            resolvedTitle = created.title
          }
        }
      } catch (err) {
        console.error('[NotePage] Failed to resolve wiki link:', err)
        toast.error('Failed to open linked note')
        return
      }

      openTab({
        type: 'note',
        title: resolvedTitle,
        icon: 'file-text',
        path: `/notes/${resolvedId}`,
        entityId: resolvedId,
        isPinned: false,
        isModified: false,
        isPreview: true,
        isDeleted: false
      })
    },
    [openTab, getNote, createNote]
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
    return <NoteErrorState error={error} onRetry={loadNote} />
  }

  // No note found
  if (!note) {
    return <NoteErrorState error="Note not found" />
  }

  return (
    <NoteLayout headings={headings} onHeadingClick={handleHeadingClick} stats={documentStats}>
      {/* Note content wrapper with relative positioning for action bar */}
      <div className="relative">
        {/* Action bar - positioned at top-right of content area */}
        <div className="absolute top-0 right-0 z-10 flex items-center gap-2">
          {/* Reminder Button */}
          {noteId && (
            <NoteReminderButton
              noteId={noteId}
              disabled={isDeleted}
            />
          )}

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
                onAddProperty={handleAddProperty}
                onDeleteProperty={handleDeleteProperty}
                disabled={isDeleted}
              />
            </div>
          </div>

          {/* Main content - BlockNote Editor with Markdown */}
          <div
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
              onRecover={loadNote}
              onError={(error) => console.error('[NotePage] Editor error:', error)}
            >
              <ContentArea
                key={`${noteId}-${externalUpdateCount}`} // Force re-mount when note changes or external update
                noteId={noteId} // T069: Required for attachment uploads
                initialContent={note.content}
                contentType="markdown"
                placeholder="Start writing, or press '/' for commands..."
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
          loadNote()
        }}
      />
    </NoteLayout>
  )
}
