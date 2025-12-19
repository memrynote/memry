/**
 * NotePage Component
 *
 * Displays and edits a note from the vault.
 * Loads real note data via useNotes() hook and saves changes via updateNote().
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { NoteLayout, HeadingItem, ContentArea, HeadingInfo, Block } from '@/components/note'
import { NoteTitle } from '@/components/note/note-title'
import { TagsRow, Tag } from '@/components/note/tags-row'
import { InfoSection, Property, NewProperty } from '@/components/note/info-section'
import { BacklinksSection, Backlink } from '@/components/note/backlinks'
import { useNotes, useNoteLinks, useNoteTags, type Note } from '@/hooks/use-notes'
import { onNoteDeleted, onNoteExternalChange } from '@/services/notes-service'
import { useTabs } from '@/contexts/tabs'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

// ============================================================================
// Types
// ============================================================================

interface NotePageProps {
  noteId?: string
}

// Tag color mapping for consistent colors
const TAG_COLORS: Tag['color'][] = [
  'red', 'blue', 'green', 'purple', 'amber',
  'yellow', 'cyan', 'pink', 'coral', 'stone'
]

function getTagColor(tagName: string): Tag['color'] {
  // Generate consistent color based on tag name hash
  let hash = 0
  for (let i = 0; i < tagName.length; i++) {
    hash = ((hash << 5) - hash) + tagName.charCodeAt(i)
    hash = hash & hash
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

// ============================================================================
// Loading State Component
// ============================================================================

function NoteLoadingState() {
  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-sm">Loading note...</p>
      </div>
    </div>
  )
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
          <button
            onClick={onRetry}
            className="text-sm text-primary hover:underline"
          >
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
  const { getNote, updateNote, renameNote } = useNotes({ autoLoad: false })
  const { incoming: rawBacklinks, isLoading: backlinksLoading } = useNoteLinks(noteId ?? null)
  const { tags: allAvailableTags } = useNoteTags()
  const { openTab, setTabDeleted } = useTabs()

  // Local state
  const [note, setNote] = useState<Note | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [headings, setHeadings] = useState<HeadingItem[]>([])
  const [isInfoExpanded, setIsInfoExpanded] = useState(false)
  const [isDeleted, setIsDeleted] = useState(false)

  // Content tracking for change detection
  const lastSavedContent = useRef<string>('')

  // Refs for debouncing
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Properties (from frontmatter - for future use)
  const [properties, setProperties] = useState<Property[]>([])

  // ============================================================================
  // Load Note
  // ============================================================================

  const loadNote = useCallback(async () => {
    if (!noteId) {
      setNote(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)
    setIsDeleted(false) // Reset deleted state when loading a new note

    try {
      const loadedNote = await getNote(noteId)
      if (loadedNote) {
        setNote(loadedNote)
        lastSavedContent.current = loadedNote.content

        // Extract properties from frontmatter (for future use)
        const frontmatterProps: Property[] = []
        if (loadedNote.frontmatter) {
          Object.entries(loadedNote.frontmatter).forEach(([key, value]) => {
            if (!['id', 'title', 'created', 'modified', 'tags', 'aliases'].includes(key)) {
              frontmatterProps.push({
                id: key,
                name: key,
                type: typeof value === 'boolean' ? 'checkbox' :
                      typeof value === 'number' ? 'number' :
                      typeof value === 'string' && value.startsWith('http') ? 'url' : 'text',
                value,
                isCustom: true
              })
            }
          })
        }
        setProperties(frontmatterProps)
      } else {
        setError('Note not found')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load note')
    } finally {
      setIsLoading(false)
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

    const handleExternalChange = (event: { id: string; type: string }) => {
      if (event.id === noteId && event.type === 'deleted') {
        setIsDeleted(true)
        setTabDeleted(noteId, true)
      }
    }

    const unsubDeleted = onNoteDeleted(handleDeleted)
    const unsubExternal = onNoteExternalChange(handleExternalChange)

    return () => {
      unsubDeleted()
      unsubExternal()
    }
  }, [noteId, setTabDeleted])

  // ============================================================================
  // Tags - Convert between string[] and Tag[]
  // ============================================================================

  const noteTags: Tag[] = useMemo(() => {
    return (note?.tags || []).map((tagName) => ({
      id: tagName,
      name: tagName,
      color: getTagColor(tagName)
    }))
  }, [note?.tags])

  const availableTags: Tag[] = useMemo(() => {
    return allAvailableTags.map((t) => ({
      id: t.tag,
      name: t.tag,
      color: getTagColor(t.tag)
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
      mentions: bl.context ? [{
        id: `mention-${bl.sourceId}`,
        snippet: bl.context,
        linkStart: 0,
        linkEnd: 0
      }] : []
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
  const handleMarkdownChange = useCallback((markdown: string) => {
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
      setIsSaving(true)
      try {
        await updateNote({ id: noteId, content: markdown })
        lastSavedContent.current = markdown
      } catch (err) {
        console.error('Failed to save note:', err)
      } finally {
        setIsSaving(false)
      }
    }, 500)
  }, [noteId, note, updateNote, isDeleted])

  const handleContentChange = useCallback((_blocks: Block[]) => {
    // Content change is handled via onMarkdownChange
  }, [])

  const handleTitleChange = useCallback(async (newTitle: string) => {
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
  }, [noteId, note, renameNote, isDeleted])

  const handleEmojiChange = useCallback((_newEmoji: string | null) => {
    // Emoji handling could be stored in frontmatter in the future
  }, [])

  // Tag handlers
  const handleAddTag = useCallback(async (tagId: string) => {
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
  }, [noteId, note, availableTags, updateNote, isDeleted])

  const handleCreateTag = useCallback(async (name: string, _color: string) => {
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
  }, [noteId, note, updateNote, isDeleted])

  const handleRemoveTag = useCallback(async (tagId: string) => {
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
  }, [noteId, note, updateNote, isDeleted])

  // Property handlers
  const handlePropertyChange = useCallback((propertyId: string, value: unknown) => {
    setProperties((prev) =>
      prev.map((p) => (p.id === propertyId ? { ...p, value } : p))
    )
    // TODO: Save to frontmatter
  }, [])

  const handleAddProperty = useCallback((newProp: NewProperty) => {
    const property: Property = {
      id: `custom-${Date.now()}`,
      name: newProp.name,
      type: newProp.type,
      value: null,
      isCustom: true
    }
    setProperties((prev) => [...prev, property])
    // TODO: Save to frontmatter
  }, [])

  const handleDeleteProperty = useCallback((propertyId: string) => {
    setProperties((prev) => prev.filter((p) => p.id !== propertyId))
    // TODO: Save to frontmatter
  }, [])

  // Link handlers
  const handleLinkClick = useCallback((href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])

  const handleInternalLinkClick = useCallback((linkedNoteId: string) => {
    openTab({
      type: 'note',
      title: 'Loading...',
      icon: 'file-text',
      path: `/notes/${linkedNoteId}`,
      entityId: linkedNoteId,
      isPinned: false,
      isModified: false,
      isPreview: true
    })
  }, [openTab])

  const handleBacklinkClick = useCallback((backlinkNoteId: string) => {
    openTab({
      type: 'note',
      title: 'Loading...',
      icon: 'file-text',
      path: `/notes/${backlinkNoteId}`,
      entityId: backlinkNoteId,
      isPinned: false,
      isModified: false,
      isPreview: true
    })
  }, [openTab])

  // ============================================================================
  // Render
  // ============================================================================

  // No note ID - show empty state
  if (!noteId) {
    return <NoteEmptyState />
  }

  // Loading
  if (isLoading) {
    return <NoteLoadingState />
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
    <NoteLayout headings={headings} onHeadingClick={handleHeadingClick}>
      {/* Saving indicator */}
      {isSaving && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 text-xs text-muted-foreground bg-background/80 backdrop-blur-sm px-3 py-1.5 rounded-full border">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Saving...</span>
        </div>
      )}

      {/* Note content */}
      <div className="space-y-8">
        <div style={{ paddingInline: "54px" }}>
          {/* Title section */}
          <div className="space-y-4">
            <div className="relative">
              <div
                className="absolute -left-8 top-1/2 -translate-y-1/2 w-1 h-12 bg-gradient-to-b from-amber-400/40 via-amber-500/20 to-transparent rounded-full opacity-60"
                aria-hidden="true"
              />
              <NoteTitle
                emoji={null}
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

          {/* Info Section (Properties from frontmatter) */}
          {properties.length > 0 && (
            <div>
              <InfoSection
                properties={properties}
                isExpanded={isInfoExpanded}
                onToggleExpand={() => setIsInfoExpanded(!isInfoExpanded)}
                onPropertyChange={handlePropertyChange}
                onAddProperty={handleAddProperty}
                onDeleteProperty={handleDeleteProperty}
              />
            </div>
          )}
        </div>

        {/* Main content - BlockNote Editor with Markdown */}
        <div
          className="editor-click-area min-h-[400px] relative"
          onMouseDown={(e) => {
            const target = e.target as HTMLElement
            if (target.closest('[contenteditable="true"]')?.contains(target) &&
                target.closest('.bn-block-content')) {
              return
            }
            if (target.closest('button, a, input')) {
              return
            }
            const editor = (e.currentTarget as HTMLElement).querySelector('.bn-editor [contenteditable="true"]') as HTMLElement
            if (editor) {
              e.preventDefault()
              editor.focus()
            }
          }}
        >
          <ContentArea
            key={noteId} // Force re-mount when note changes
            initialContent={note.content}
            contentType="markdown"
            placeholder="Start writing, or press '/' for commands..."
            onContentChange={handleContentChange}
            onMarkdownChange={handleMarkdownChange}
            onHeadingsChange={handleHeadingsChange}
            onLinkClick={handleLinkClick}
            onInternalLinkClick={handleInternalLinkClick}
          />
        </div>

        {/* Backlinks section */}
        <div className="pt-8 mx-[54px] border-t border-border/30">
          <div className="flex items-baseline gap-2 mb-4">
            <span className="font-sans text-xs font-medium uppercase tracking-wider text-text-tertiary/50">
              References
            </span>
            <span className="font-serif text-xs italic text-text-tertiary/30">
              {backlinks.length} backlink{backlinks.length !== 1 ? 's' : ''}
            </span>
          </div>
          <BacklinksSection
            backlinks={backlinks}
            isLoading={backlinksLoading}
            initialCount={5}
            collapsible={true}
            onBacklinkClick={handleBacklinkClick}
          />
        </div>
      </div>
    </NoteLayout>
  )
}
