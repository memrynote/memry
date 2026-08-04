import { getI18n } from 'react-i18next'
/**
 * NotePage Component
 *
 * Displays and edits a note from the vault.
 * Loads real note data via useNotes() hook and saves changes via updateNote().
 */

import { useState, useCallback, useEffect, useRef, useMemo, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { motion, useReducedMotion } from 'motion/react'
import { useQueryClient } from '@tanstack/react-query'
import { ExportDialog } from '@/components/note/export-dialog'
import { VersionHistory } from '@/components/note/version-history'
import { ApplyTemplateToNoteDialog } from '@/components/note/apply-template-to-note-dialog'
import { EditorErrorBoundary } from '@/components/note/editor-error-boundary'
import { NoteLayout, HeadingItem, ContentArea, HeadingInfo, Block } from '@/components/note'
import { NoteTitle } from '@/components/note/note-title'
import { TagsRow, Tag } from '@/components/note/tags-row'
import { InfoSection, type NewProperty } from '@/components/note/info-section'
import { GhostAffordanceRow } from '@/components/note/ghost-affordance-row'
import { BacklinksSection, Backlink, Mention, backlinkId } from '@/components/note/backlinks'
import { LinkedTasksSection } from '@/components/note/linked-tasks'
import {
  useNote,
  useNoteMutations,
  useNoteLinksQuery,
  useNoteTagsQuery,
  type Note
} from '@/hooks/use-notes-query'
import { usePropertySection, type PropertySectionAction } from '@/hooks/use-property-section'
import { usePropertiesCollapsed } from '@/hooks/use-properties-collapsed'
import { useTasksLinkedToNote } from '@/hooks/use-tasks-linked-to-note'
import { notesService, onNoteDeleted, onNoteUpdated, onNoteRenamed } from '@/services/notes-service'
import { resolveWikiLink } from '@/lib/wikilink-resolver'
import { useTabs, useActiveTab } from '@/contexts/tabs'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { ReminderPicker } from '@/components/reminder'
import { useNoteReminders } from '@/hooks/use-note-reminders'
import {
  Bookmark2,
  MoreVertical,
  FilePaste,
  Download,
  AlarmClock,
  Monitor,
  Maximize,
  ChartRelationship,
  PenLine,
  Pencil,
  Search,
  FolderInput,
  Copy,
  FolderOpen,
  PanelLeft,
  ExternalLink,
  Trash2
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Picker } from '@/components/ui/picker'
import { Switch } from '@/components/ui/switch'
import { MoveToFolderDialog } from '@/components/folder-view/move-to-folder-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { useIsBookmarked } from '@/hooks/use-bookmarks'
import { useEditorSettings, EDITOR_NORMAL_CONTENT_WIDTH } from '@/hooks/use-editor-settings'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { LocalGraphPanel } from '@/components/graph/local-graph-panel'
import { graphKeys } from '@/hooks/use-graph-data'
import { NoteBreadcrumb } from '@/components/note/note-breadcrumb'
import { FindBar } from '@/components/find-bar/find-bar'
import { useFindInPage } from '@/hooks/use-find-in-page'
import { ReviewBadgeLayer, ReviewRail, useCriticMarkupReview } from '@/components/note/review'

import { useT } from '@memry/i18n/renderer'
import { getTabIconForFileType } from '@memry/shared/file-types'

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
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')

  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-destructive font-medium">{t('page.error.title')}</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="text-sm text-primary hover:underline">
            {tCommon('button.retry')}
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
  const { t } = useT('notes')

  return (
    <div className="flex items-center justify-center h-full min-h-[400px]">
      <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
        <p className="text-sm">{t('page.empty.title')}</p>
        <p className="text-xs">{t('page.empty.body')}</p>
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function NotePage({ noteId }: NotePageProps) {
  const { t } = useT('notes')
  // TanStack Query hooks for data fetching with caching
  const { note, isLoading, error: noteError, refetch: refetchNote } = useNote(noteId ?? null)
  const { createNote, updateNote, renameNote, deleteNote, moveNote } = useNoteMutations()
  const { incoming: rawBacklinks, isLoading: backlinksLoading } = useNoteLinksQuery(noteId ?? null)
  const { tasks: linkedTasks, isLoading: linkedTasksLoading } = useTasksLinkedToNote(noteId ?? null)
  const { tags: allAvailableTags } = useNoteTagsQuery()
  const { openTab, setTabDeleted, updateTabTitleByEntityId, closeTab } = useTabs()
  const activeTab = useActiveTab()
  const { openSidebarItem } = useSidebarNavigation()
  const queryClient = useQueryClient()
  const prefersReducedMotion = useReducedMotion()

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

  // Extract inline date pill anchor from tab viewState (from note_date reminder navigation)
  const initialAnchorId = useMemo(() => {
    const viewState = activeTab?.viewState as { anchorId?: string } | undefined
    return viewState?.anchorId
  }, [activeTab?.viewState])

  // Convert query error to string
  const error = noteError?.message ?? null

  // Local state (UI-only, not data loading)
  const [headings, setHeadings] = useState<HeadingItem[]>([])
  const [isDeleted, setIsDeleted] = useState(false)
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [isApplyTemplateOpen, setIsApplyTemplateOpen] = useState(false)
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false)
  const [isLocalGraphOpen, setIsLocalGraphOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  // External ref to the inline title textarea so the "Rename" menu item can focus it
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null)
  const [externalUpdateCount, setExternalUpdateCount] = useState(0)
  const [eventContentOverride, setEventContentOverride] = useState<{
    noteId: string
    content: string
  } | null>(null)
  const [storedNoteIdForContent, setStoredNoteIdForContent] = useState(noteId)

  // #800 belt-and-suspenders: a filed binary (image/PDF/…) mis-opened as a note
  // tab must never mount the markdown editor — raw bytes render as junk tag
  // pills and a multi-MB blob freezes the app. Probe getFile (null for real
  // markdown notes); if this id is actually a file, redirect the tab to the
  // in-app viewer. Render nothing until the probe resolves so the editor never
  // mounts on a binary. Runs concurrently with the note load, so it adds no
  // perceptible latency for normal notes. The result is keyed by id so a stale
  // result for a previous note reads as 'pending' during render (no reset in
  // the effect).
  const [fileProbe, setFileProbe] = useState<{ id: string | null; status: 'note' | 'file' }>({
    id: null,
    status: 'note'
  })
  const fileProbeStatus = fileProbe.id === noteId ? fileProbe.status : 'pending'
  useEffect(() => {
    if (!noteId) return
    let cancelled = false
    void notesService
      .getFile(noteId)
      .then((file) => {
        if (cancelled) return
        if (!file) {
          setFileProbe({ id: noteId, status: 'note' })
          return
        }
        setFileProbe({ id: noteId, status: 'file' })
        const fileTab = {
          type: 'file' as const,
          title: file.title,
          icon: getTabIconForFileType(file.fileType),
          path: `/file/${noteId}`,
          entityId: noteId,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        }
        // Convert THIS tab in place. openTab dedups by entityId, so a plain
        // openTab would just re-focus the existing note tab without changing its
        // type/icon — replaceActive swaps the active tab for the file viewer.
        // Guard on the active tab being this note (replaceActive replaces the
        // group's active tab, so an unguarded call in a split/background pane
        // would clobber an unrelated tab) and skip pinned tabs (replaceActive
        // no-ops on them); the render gate already prevents the editor from
        // mounting on the binary in those rare fallthrough cases.
        if (activeTab?.entityId === noteId && !activeTab.isPinned) {
          openTab(fileTab, { replaceActive: true })
        } else {
          openTab(fileTab)
        }
      })
      .catch(() => {
        if (!cancelled) setFileProbe({ id: noteId, status: 'note' })
      })
    return () => {
      cancelled = true
    }
  }, [noteId, openTab, activeTab?.entityId, activeTab?.isPinned])

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
    newlyAddedPropertyId,
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

  const [propertiesCollapsed, togglePropertiesCollapsed, setPropertiesCollapsed] =
    usePropertiesCollapsed(noteId ?? '')

  const handleAddPropertyWithExpand = useCallback(
    (newProp: NewProperty) => {
      setPropertiesCollapsed(false)
      handleAddProperty(newProp)
    },
    [handleAddProperty, setPropertiesCollapsed]
  )

  // Bookmark state
  const { isBookmarked, toggle: toggleBookmark } = useIsBookmarked('note', noteId ?? '')

  // Reminder state
  const { hasActiveReminder, actions: reminderActions } = useNoteReminders(noteId ?? null)
  const handleSetReminder = useCallback(
    async (date: Date, reminderNote?: string): Promise<void> => {
      await reminderActions.setReminder(date, reminderNote)
    },
    [reminderActions]
  )

  // Editor settings (toolbar mode, width)
  const { settings: editorSettings } = useEditorSettings()

  // Width follows the global setting (Normal / Full) unless this note has an
  // explicit per-note override in frontmatter (`fullWidth`), which wins.
  const widthOverride = note?.frontmatter.fullWidth
  const isFullWidth =
    typeof widthOverride === 'boolean' ? widthOverride : editorSettings.width === 'full'
  const noteContentWidth = isFullWidth ? undefined : EDITOR_NORMAL_CONTENT_WIDTH

  // Focus editor at end when clicking empty space
  const focusAtEndRef = useRef<(() => void) | null>(null)

  // Find in page (Cmd+F)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const [marqueeZoneEl, setMarqueeZoneEl] = useState<HTMLDivElement | null>(null)

  // Click anywhere in the marquee zone (full scroll area, minus title/metadata
  // and editable text) → focus editor at end. Attached imperatively so it
  // coexists with the marquee hook's own mousedown listener.
  useEffect(() => {
    if (!marqueeZoneEl) return
    const handler = (event: MouseEvent): void => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-marquee-ignore]')) return
      if (target.closest('button, a, input, textarea, select, [role="button"]')) return
      // BlockNote's side menu, drag-handle menu, toolbars and their nested
      // dropdowns render inside the marquee zone (not portaled). A mousedown on
      // one must NOT focus the editor: stealing focus unmounts the menu between
      // mousedown and mouseup, so the item's click never fires (drag-handle
      // Colors/Delete silently did nothing). Mirror the marquee hook's
      // exclusion list, plus menu roles for nested submenus.
      if (
        target.closest(
          '.bn-side-menu, .bn-formatting-toolbar, .bn-suggestion-menu, .bn-link-toolbar, .bn-drag-handle-menu, .bn-menu-dropdown, [role="menu"]'
        )
      )
        return
      if (
        target.closest('[contenteditable="true"]')?.contains(target) &&
        target.closest('.bn-block-content')
      )
        return
      event.preventDefault()
      focusAtEndRef.current?.()
    }
    marqueeZoneEl.addEventListener('mousedown', handler)
    return () => marqueeZoneEl.removeEventListener('mousedown', handler)
  }, [marqueeZoneEl])

  const isActiveNote = activeTab?.entityId === noteId
  const findInPage = useFindInPage(
    editorContainerRef as RefObject<HTMLElement | null>,
    isActiveNote
  )

  // Native menu bar: Edit > Find and File > Export to PDF target the active note.
  useEffect(() => {
    if (!isActiveNote) return
    const onFind = (): void => findInPage.open()
    const onExport = (): void => setIsExportDialogOpen(true)
    window.addEventListener('memry:menu-find', onFind)
    window.addEventListener('memry:menu-export', onExport)
    return () => {
      window.removeEventListener('memry:menu-find', onFind)
      window.removeEventListener('memry:menu-export', onExport)
    }
  }, [isActiveNote, findInPage])

  // Content tracking for change detection
  if (storedNoteIdForContent !== noteId) {
    setStoredNoteIdForContent(noteId)
    setEventContentOverride(null)
  }

  let editorInitialContent = note?.content ?? ''
  if (eventContentOverride !== null && eventContentOverride.noteId === noteId) {
    editorInitialContent = eventContentOverride.content
  }

  const documentStats = useMemo(() => {
    if (!note) return undefined
    return {
      wordCount: note.wordCount ?? 0,
      characterCount: editorInitialContent.length,
      createdAt: note.created ?? null,
      modifiedAt: note.modified ?? null
    }
  }, [editorInitialContent.length, note])

  const lastSavedContent = useRef<string>('')

  // Refs for debouncing
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingMarkdownRef = useRef<string | null>(null)

  // ============================================================================
  // Sync lastSavedContent with note data from query
  // ============================================================================

  const noteContentForLastSaved = note?.content

  // Update lastSavedContent when note data changes (from cache or fresh fetch)
  useEffect(() => {
    if (noteContentForLastSaved !== undefined) {
      lastSavedContent.current = noteContentForLastSaved
    }
  }, [noteContentForLastSaved])

  // Reset deleted state during render when switching to a new note.
  const [storedNoteIdForDelete, setStoredNoteIdForDelete] = useState(note?.id)
  if (storedNoteIdForDelete !== note?.id) {
    setStoredNoteIdForDelete(note?.id)
    setIsDeleted(false)
  }

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

  // Listen for note updates that did not originate from this editor instance.
  // Track if we're currently saving to ignore our own updates
  const isSavingRef = useRef(false)

  useEffect(() => {
    if (!noteId) return

    const handleUpdated = (event: { id: string; changes: Partial<Note>; source?: string }) => {
      if (event.id !== noteId) return

      if (isSavingRef.current) return

      // TanStack Query will handle the cache invalidation and refetch.
      // We just need to update lastSavedContent and force editor remount.
      if (typeof event.changes.content !== 'string') return
      if (event.changes.content === lastSavedContent.current) return

      lastSavedContent.current = event.changes.content
      setEventContentOverride({ noteId, content: event.changes.content })

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

  const pendingTagColorsRef = useRef(new Map<string, string>())

  // Maps keyed by lowercase: tag identity is case-insensitive, display keeps user casing
  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of allAvailableTags) {
      map.set(t.tag.toLowerCase(), t.color)
    }
    for (const key of pendingTagColorsRef.current.keys()) {
      if (map.has(key)) pendingTagColorsRef.current.delete(key)
    }
    // Just-created tags aren't in allAvailableTags until reindex+refetch;
    // without this the editor pill falls back to the hashed default color
    for (const [key, color] of pendingTagColorsRef.current) {
      if (!map.has(key)) map.set(key, color)
    }
    return map
  }, [allAvailableTags])

  const tagIconMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of allAvailableTags) {
      if (t.icon) map.set(t.tag.toLowerCase(), t.icon)
    }
    return map
  }, [allAvailableTags])

  const noteTags: Tag[] = useMemo(() => {
    return (note?.tags || []).map((tagName) => ({
      id: tagName,
      name: tagName,
      color:
        tagColorMap.get(tagName.toLowerCase()) ??
        pendingTagColorsRef.current.get(tagName.toLowerCase()) ??
        '',
      icon: tagIconMap.get(tagName.toLowerCase()) ?? null
    }))
  }, [note?.tags, tagColorMap, tagIconMap])

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
        id: backlinkId(bl.sourceId, bl.via),
        noteId: bl.sourceId,
        noteTitle: bl.sourceTitle,
        folder: folderPath,
        date: new Date(),
        mentions: (bl.contexts ?? []).map((ctx, i) => ({
          id: `mention-${bl.sourceId}-${i}`,
          snippet: ctx.snippet,
          linkStart: ctx.linkStart,
          linkEnd: ctx.linkEnd
        })),
        via: bl.via
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
        toast.error(t('page.toast.cannotSaveDeleted'))
        return
      }

      // Skip if content hasn't changed
      if (markdown === lastSavedContent.current) return

      pendingMarkdownRef.current = markdown

      // Clear previous timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }

      // Debounce save (fixed 1000ms)
      saveTimeoutRef.current = setTimeout(() => {
        void (async () => {
          isSavingRef.current = true
          try {
            await updateNote.mutateAsync({ id: noteId, content: markdown })
            lastSavedContent.current = markdown
            setEventContentOverride(null)
            pendingMarkdownRef.current = null
            if (isLocalGraphOpen) {
              void queryClient.invalidateQueries({ queryKey: graphKeys.local(noteId) })
            }
          } catch (err) {
            log.error('Failed to save note:', err)
          } finally {
            isSavingRef.current = false
          }
        })()
      }, 1000)
    },
    [noteId, note, isDeleted, t, updateNote, isLocalGraphOpen, queryClient]
  )

  const handleContentChange = useCallback((_blocks: Block[]) => {
    // Content change is handled via onMarkdownChange
  }, [])

  const review = useCriticMarkupReview({
    markdown: editorInitialContent,
    onMarkdownChange: handleMarkdownChange
  })
  const hasReviewContent = review.marks.length > 0 || !!review.activeDraft
  const [reviewRailHidden, setReviewRailHidden] = useState(false)

  const handleTitleChange = useCallback(
    async (newTitle: string) => {
      if (!noteId || !note || newTitle === note.title) return

      if (isDeleted) {
        toast.error(t('page.toast.cannotRenameDeleted'))
        return
      }

      try {
        await renameNote.mutateAsync({ id: noteId, newTitle })
        // Note will be updated via TanStack Query cache invalidation
      } catch (err) {
        log.error('Failed to rename note:', err)
      }
    },
    [noteId, note, isDeleted, t, renameNote]
  )

  // Tag handlers
  const handleAddTag = useCallback(
    async (tagId: string) => {
      if (!noteId || !note) return

      if (isDeleted) {
        toast.error(
          getI18n().getFixedT(null, 'notes')('phaseI.toasts.cannotAddTagThisNoteWasDeleted')
        )
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
    [noteId, note, isDeleted, availableTags, updateNote]
  )

  const handleCreateTag = useCallback(
    async (name: string, color: string) => {
      if (!noteId || !note) return

      if (isDeleted) {
        toast.error(
          getI18n().getFixedT(null, 'notes')('phaseI.toasts.cannotAddTagThisNoteWasDeleted')
        )
        return
      }

      if (!note.tags.includes(name)) {
        pendingTagColorsRef.current.set(name.toLowerCase(), color)
        const newTags = [...note.tags, name]
        try {
          await updateNote.mutateAsync({ id: noteId, tags: newTags })
        } catch (err) {
          pendingTagColorsRef.current.delete(name.toLowerCase())
          log.error('Failed to create tag:', err)
        }
      }
    },
    [noteId, note, isDeleted, updateNote]
  )

  const handleRemoveTag = useCallback(
    async (tagId: string) => {
      if (!noteId || !note) return

      if (isDeleted) {
        toast.error(
          getI18n().getFixedT(null, 'notes')('phaseI.toasts.cannotRemoveTagThisNoteWasDeleted')
        )
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
    [noteId, note, isDeleted, updateNote]
  )

  // Inline #tag sync: track which tags come from editor content
  // pendingTagsRef bridges concurrent async calls so the second update
  // builds on top of the first instead of overwriting it with stale data
  const inlineTagsRef = useRef<Set<string>>(new Set())
  const pendingTagsRef = useRef<string[] | null>(null)

  const handleInlineTagsChange = useCallback(
    async (currentInlineTags: string[]) => {
      if (!noteId || !note || isDeleted) return

      const prev = inlineTagsRef.current
      const current = new Set(currentInlineTags)

      const baseTags = pendingTagsRef.current ?? note.tags

      const tagsToAdd = currentInlineTags.filter((t) => !prev.has(t) && !baseTags.includes(t))
      const tagsToRemove = Array.from(prev).filter((t) => !current.has(t) && baseTags.includes(t))

      inlineTagsRef.current = current

      if (tagsToAdd.length === 0 && tagsToRemove.length === 0) return

      let newTags = [...baseTags]
      for (const tag of tagsToAdd) {
        if (!newTags.includes(tag)) newTags.push(tag)
      }
      for (const tag of tagsToRemove) {
        newTags = newTags.filter((t) => t !== tag)
      }

      pendingTagsRef.current = newTags

      try {
        await updateNote.mutateAsync({ id: noteId, tags: newTags })
      } catch (err) {
        log.error('Failed to sync inline tags:', err)
      } finally {
        if (pendingTagsRef.current === newTags) {
          pendingTagsRef.current = null
        }
      }
    },
    [noteId, note, isDeleted, updateNote]
  )

  // Local-only toggle
  const handleToggleLocalOnly = useCallback(
    async (value: boolean) => {
      if (!noteId) return
      if (isDeleted) {
        toast.error(
          getI18n().getFixedT(
            null,
            'notes'
          )('phaseI.toasts.cannotChangeLocalOnlyThisNoteWasDeleted')
        )
        return
      }
      try {
        await notesService.setLocalOnly(noteId, value)
        refetchNote()
        void queryClient.invalidateQueries({ queryKey: ['notes', 'localOnlyCount'] })
        toast.success(value ? t('page.toast.localOnly') : t('page.toast.willSync'))
      } catch (err) {
        toast.error(extractErrorMessage(err, t('page.toast.toggleLocalOnlyFailed')))
      }
    },
    [noteId, isDeleted, refetchNote, queryClient, t]
  )

  const handleToggleFullWidth = useCallback(
    async (value: boolean) => {
      if (!noteId || isDeleted) return
      try {
        await notesService.update({ id: noteId, frontmatter: { fullWidth: value } })
        refetchNote()
      } catch (err) {
        toast.error(extractErrorMessage(err, t('page.toast.toggleFullWidthFailed')))
      }
    },
    [noteId, isDeleted, refetchNote, t]
  )

  // ── Note-view menu file actions ───────────────────────────────────────────

  // Rename: focus + select the inline title textarea (no dialog).
  // Deferred so the menu's focus-restore-on-close does not steal focus back.
  const handleRename = useCallback(() => {
    requestAnimationFrame(() => {
      const el = titleInputRef.current
      if (!el) return
      el.focus()
      el.select()
    })
  }, [])

  // Copy the vault-relative path (Obsidian parity; no IPC, OS-agnostic)
  const handleCopyPath = useCallback(async () => {
    if (!note) return
    try {
      await navigator.clipboard.writeText(note.path)
      toast.success(t('page.toast.pathCopied'))
    } catch (err) {
      toast.error(extractErrorMessage(err, t('page.toast.copyPathFailed')))
    }
  }, [note, t])

  // Reveal in the OS file manager (Finder / Explorer / file manager)
  const handleRevealInFinder = useCallback(async () => {
    if (!noteId) return
    try {
      await notesService.revealInFinder(noteId)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('page.toast.revealFailed')))
    }
  }, [noteId, t])

  // Reveal in the app sidebar / navigation tree
  const handleRevealInSidebar = useCallback(() => {
    if (!noteId) return
    window.dispatchEvent(
      new CustomEvent('reveal-in-sidebar', {
        detail: { path: `/notes/${noteId}`, entityId: noteId }
      })
    )
  }, [noteId])

  // Open in the OS default app for the file type
  const handleOpenExternal = useCallback(async () => {
    if (!noteId) return
    try {
      await notesService.openExternal(noteId)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('page.toast.openExternalFailed')))
    }
  }, [noteId, t])

  // Move to another folder (via the shared dialog)
  const handleMoveToFolder = useCallback(
    async (targetFolder: string) => {
      if (!noteId) return
      try {
        const result = await moveNote.mutateAsync({ id: noteId, newFolder: targetFolder })
        if (result.success) {
          toast.success(t('page.toast.moved'))
        } else {
          toast.error(result.error ?? t('page.toast.moveFailed'))
        }
      } catch (err) {
        toast.error(extractErrorMessage(err, t('page.toast.moveFailed')))
      }
    },
    [noteId, moveNote, t]
  )

  // Delete the current note, then close its tab
  const handleDeleteConfirm = useCallback(async () => {
    if (!noteId || isDeleting) return
    setIsDeleting(true)
    try {
      const result = await deleteNote.mutateAsync(noteId)
      if (result.success) {
        setIsDeleteConfirmOpen(false)
        closeTab(activeTab?.id ?? `/notes/${noteId}`)
      } else {
        toast.error(result.error ?? t('page.toast.deleteFailed'))
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, t('page.toast.deleteFailed')))
    } finally {
      setIsDeleting(false)
    }
  }, [noteId, isDeleting, deleteNote, closeTab, activeTab?.id, t])

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
              isPreview: false,
              isDeleted: false
            })
            break

          case 'create': {
            // Create new note with this title
            const result = await createNote.mutateAsync({ title: target })
            if (!result.success || !result.note) {
              toast.error(t('page.toast.createLinkedFailed'))
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
              isPreview: false,
              isDeleted: false
            })
            break
          }

          case 'not-found':
            // File-like target not found - show error instead of creating a note
            toast.error(`File not found: ${target}`)
            break
        }
      } catch (err) {
        log.error('Failed to resolve wiki link:', err)
        toast.error(t('page.toast.openLinkedFailed'))
      }
    },
    [openTab, createNote, t]
  )

  const handleBacklinkClick = useCallback(
    (backlinkNoteId: string, mention?: Mention) => {
      const backlink = backlinks.find((bl) => bl.noteId === backlinkNoteId)
      const noteTitle = backlink?.noteTitle || 'Note'

      const viewState = mention
        ? {
            highlightText: mention.snippet.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').trim()
          }
        : undefined

      openTab({
        type: 'note',
        title: noteTitle,
        icon: 'file-text',
        path: `/notes/${backlinkNoteId}`,
        entityId: backlinkNoteId,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        ...(viewState && { viewState })
      })
    },
    [openTab, backlinks]
  )

  // Handle clicking on a linked task
  const handleLinkedTaskClick = useCallback(
    (taskId: string) => {
      const task = linkedTasks.find((t) => t.id === taskId)
      openTab({
        type: 'tasks',
        title: 'Tasks',
        icon: 'check-square',
        path: '/tasks',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: {
          openTaskId: taskId,
          selectedProjectId: task?.projectId ?? undefined,
          activeTab: 'all'
        }
      })
    },
    [openTab, linkedTasks]
  )

  // ============================================================================
  // Render
  // ============================================================================

  // No note ID - show empty state
  if (!noteId) {
    return <NoteEmptyState />
  }

  // #800: don't mount the markdown editor until we've confirmed this id is not a
  // filed binary. 'pending' = probe in flight; 'file' = redirecting to the file
  // viewer. Either way render nothing so a binary never reaches the editor.
  if (fileProbeStatus !== 'note') {
    return null
  }

  // Error
  if (error) {
    return <NoteErrorState error={error} onRetry={refetchNote} />
  }

  // Loading state - show nothing while fetching to avoid flash of error
  if (isLoading || !note) {
    return null
  }

  const actionIcons = (
    <div className="flex items-center gap-0.5">
      <ReminderPicker
        onSelect={(date, _title, reminderNote) => void handleSetReminder(date, reminderNote)}
        presetType="standard"
        showNote
        disabled={isDeleted}
        trigger={
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:bg-surface-active transition-all duration-150 ease-out active:scale-95 active:bg-surface-active/70 disabled:active:scale-100"
            disabled={isDeleted}
            title={
              hasActiveReminder ? t('editor.toolbar.reminderSet') : t('editor.toolbar.setReminder')
            }
          >
            <AlarmClock
              className={cn(
                'h-3.5 w-3.5',
                hasActiveReminder ? 'text-amber-500' : 'text-muted-foreground'
              )}
            />
          </Button>
        }
      />

      <Button
        variant="ghost"
        size="icon"
        className="size-7 hover:bg-surface-active transition-all duration-150 ease-out active:scale-95 active:bg-surface-active/70 disabled:active:scale-100"
        onClick={() => void toggleBookmark()}
        disabled={isDeleted}
        title={isBookmarked ? t('editor.toolbar.removeBookmark') : t('editor.toolbar.addBookmark')}
      >
        <Bookmark2
          className={cn(
            'h-3.5 w-3.5',
            isBookmarked ? 'fill-accent-orange text-accent-orange' : 'text-muted-foreground'
          )}
        />
      </Button>

      <Picker
        value={null}
        closeOnSelect={false}
        onValueChange={(action) => {
          if (action === 'full-width') {
            void handleToggleFullWidth(!isFullWidth)
            return
          }
          setMoreMenuOpen(false)
          if (action === 'local-graph') setIsLocalGraphOpen((prev) => !prev)
          if (action === 'find') findInPage.open()
          if (action === 'version-history') setIsVersionHistoryOpen(true)
          if (action === 'export') setIsExportDialogOpen(true)
          if (action === 'apply-template') setIsApplyTemplateOpen(true)
          if (action === 'rename') handleRename()
          if (action === 'move-to-folder') setIsMoveDialogOpen(true)
          if (action === 'copy-path') void handleCopyPath()
          if (action === 'reveal-in-finder') void handleRevealInFinder()
          if (action === 'reveal-in-sidebar') handleRevealInSidebar()
          if (action === 'open-external') void handleOpenExternal()
          if (action === 'delete') setIsDeleteConfirmOpen(true)
          if (action === 'local-only')
            void handleToggleLocalOnly(!(note.frontmatter.localOnly ?? false))
        }}
        open={moreMenuOpen}
        onOpenChange={setMoreMenuOpen}
      >
        <Picker.Trigger asChild disabled={isDeleted}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:bg-surface-active transition-all duration-150 ease-out active:scale-95 active:bg-surface-active/70 disabled:active:scale-100"
            disabled={isDeleted}
            data-testid="note-more-menu"
            aria-label={t('editor.toolbar.moreActions')}
          >
            <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </Picker.Trigger>
        <Picker.Content align="end">
          <Picker.List>
            <Picker.Item
              value="local-graph"
              label={
                isLocalGraphOpen
                  ? t('editor.toolbar.hideLocalGraph')
                  : t('editor.toolbar.showLocalGraph')
              }
              icon={<ChartRelationship className="size-4" />}
            />
            <Picker.Item
              value="find"
              label={t('editor.toolbar.find')}
              icon={<Search className="size-4" />}
            />
            <Picker.Item
              value="version-history"
              label={t('editor.toolbar.versionHistory')}
              icon={<FilePaste className="size-4" />}
            />
            <Picker.Item
              value="export"
              label={t('editor.toolbar.export')}
              icon={<Download className="size-4" />}
            />
            <Picker.Item
              value="apply-template"
              label={t('editor.toolbar.applyTemplate')}
              icon={<PenLine className="size-4" />}
            />
            <Picker.Item
              value="full-width"
              label={t('editor.toolbar.fullWidth')}
              icon={<Maximize className="size-4" />}
              trailing={
                <Switch
                  checked={isFullWidth}
                  className="pointer-events-none h-4 w-7"
                  tabIndex={-1}
                />
              }
            />
            <Picker.Separator />
            <Picker.Item
              value="rename"
              label={t('editor.toolbar.rename')}
              icon={<Pencil className="size-4" />}
            />
            <Picker.Item
              value="move-to-folder"
              label={t('editor.toolbar.moveToFolder')}
              icon={<FolderInput className="size-4" />}
            />
            <Picker.Item
              value="copy-path"
              label={t('editor.toolbar.copyPath')}
              icon={<Copy className="size-4" />}
            />
            <Picker.Separator />
            <Picker.Item
              value="reveal-in-finder"
              label={t('editor.toolbar.revealInFinder')}
              icon={<FolderOpen className="size-4" />}
            />
            <Picker.Item
              value="reveal-in-sidebar"
              label={t('editor.toolbar.revealInSidebar')}
              icon={<PanelLeft className="size-4" />}
            />
            <Picker.Item
              value="open-external"
              label={t('editor.toolbar.openInDefaultApp')}
              icon={<ExternalLink className="size-4" />}
            />
            <Picker.Separator />
            <Picker.Item
              value="local-only"
              label={
                note.frontmatter.localOnly
                  ? t('editor.toolbar.disableLocalOnly')
                  : t('editor.toolbar.setLocalOnly')
              }
              icon={<Monitor className="size-4" />}
            />
            <Picker.Separator />
            <Picker.Item
              value="delete"
              label={t('editor.toolbar.delete')}
              icon={<Trash2 className="size-4" />}
              destructive
            />
          </Picker.List>
        </Picker.Content>
      </Picker>
    </div>
  )

  return (
    <NoteLayout
      headings={headings}
      onHeadingClick={handleHeadingClick}
      actions={actionIcons}
      fullWidth={isFullWidth}
      contentWidth={noteContentWidth ?? undefined}
      sideRail={hasReviewContent ? <ReviewRail review={review} targetId={noteId} /> : undefined}
      onRailHiddenChange={setReviewRailHidden}
      marqueeZoneRef={setMarqueeZoneEl}
      topBar={
        <FindBar
          isOpen={findInPage.isOpen}
          query={findInPage.query}
          matchCount={findInPage.matchCount}
          currentIndex={findInPage.currentIndex}
          inputRef={findInPage.inputRef}
          onQueryChange={findInPage.setQuery}
          onNext={findInPage.next}
          onPrev={findInPage.prev}
          onClose={findInPage.close}
        />
      }
      breadcrumb={<NoteBreadcrumb notePath={note.path} noteTitle={note.title} />}
      stats={documentStats}
    >
      {/* Note content — materializes on note switch (crossfade only under
          reduced motion); critically damped spring, no overshoot */}
      <motion.div
        key={noteId}
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
        className="flex flex-col flex-1 mx-auto w-full transition-[max-width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ maxWidth: noteContentWidth ?? '100%' }}
      >
        {/* Title + Metadata zone — ghost affordance appears on hover */}
        <div className="group/metadata flex flex-col gap-2.5 pb-[15px]" data-marquee-ignore>
          <NoteTitle
            emoji={null}
            title={note.title}
            onTitleChange={(...args) => void handleTitleChange(...args)}
            placeholder={t('editor.title.untitled')}
            inputRef={titleInputRef}
          />

          {/* Tags: visible when tags exist */}
          <TagsRow
            tags={noteTags}
            availableTags={availableTags}
            recentTags={recentTags}
            onAddTag={(...args) => void handleAddTag(...args)}
            onCreateTag={(...args) => void handleCreateTag(...args)}
            onRemoveTag={(...args) => void handleRemoveTag(...args)}
            onTagClick={(tag) =>
              openSidebarItem({
                type: 'tag',
                title: tag.name,
                path: '/tags/' + tag.name,
                entityId: tag.name,
                color: tag.color
              })
            }
            hideWhenEmpty
            hideAddButton
          />

          {properties.length > 0 && (
            <InfoSection
              properties={properties}
              newlyAddedPropertyId={newlyAddedPropertyId}
              isExpanded={!propertiesCollapsed}
              onToggleExpand={togglePropertiesCollapsed}
              onPropertyChange={handlePropertyChange}
              onPropertyNameChange={handlePropertyNameChange}
              onPropertyOrderChange={handlePropertyOrderChange}
              onAddProperty={handleAddPropertyWithExpand}
              onDeleteProperty={handleDeleteProperty}
              disabled={isDeleted}
              variant="embedded"
              hideAddButton
            />
          )}

          {/* Ghost affordance: add tag/property — fades in on hover/focus, placed
              below the metadata so it never sits above the title */}
          <GhostAffordanceRow
            availableTags={availableTags}
            recentTags={recentTags}
            currentTagIds={noteTags.map((t) => t.id)}
            onAddTag={(...args) => void handleAddTag(...args)}
            onCreateTag={(...args) => void handleCreateTag(...args)}
            onAddProperty={handleAddPropertyWithExpand}
            existingNames={properties.map((p) => p.name)}
            disabled={isDeleted}
          />
        </div>

        {/* Main content - BlockNote Editor */}
        <div
          ref={editorContainerRef}
          role="presentation"
          className="editor-click-area flex-1 pb-[30vh] relative"
        >
          <EditorErrorBoundary
            noteId={noteId}
            onRecover={refetchNote}
            onError={(error) => log.error('Editor error:', error)}
          >
            <ContentArea
              key={`${noteId}-${externalUpdateCount}`}
              noteId={noteId}
              notePath={note.path}
              initialContent={review.editorInitialContent}
              contentType="markdown"
              placeholder={t('editor.content.placeholder')}
              stickyToolbar={editorSettings.toolbarMode === 'sticky'}
              spellCheck={editorSettings.spellCheck}
              onContentChange={handleContentChange}
              onMarkdownChange={handleMarkdownChange}
              onHeadingsChange={handleHeadingsChange}
              onLinkClick={handleLinkClick}
              onInternalLinkClick={(...args) => void handleInternalLinkClick(...args)}
              initialHighlight={initialHighlight}
              initialAnchorId={initialAnchorId}
              noteTags={note.tags}
              tagColorMap={tagColorMap}
              tagIconMap={tagIconMap}
              onInlineTagsChange={(...args) => void handleInlineTagsChange(...args)}
              focusAtEndRef={focusAtEndRef}
              marqueeZoneEl={marqueeZoneEl}
              review={{
                plainMarkdown: review.plainMarkdown,
                marks: review.marks,
                hoveredMarkId: review.hoveredMarkId,
                onEditorReady: review.handleEditorReady,
                onAddComment: review.openCommentComposer,
                getMarkdownSourceOffsetForEditorOffset:
                  review.getMarkdownSourceOffsetForEditorOffset,
                getEditorOffsetForMarkdownSourceOffset:
                  review.getEditorOffsetForMarkdownSourceOffset,
                onPersistCurrentMarkdown: review.persistCurrentMarkdown,
                onPlainMarkdownChange: review.handlePlainMarkdownChange,
                onHoveredMarkChange: review.setHoveredMarkId,
                onMarkPositionsChange: review.setMarkPositions,
                onReplaceMarksFromYjs: review.replaceMarksFromYjs
              }}
            />
          </EditorErrorBoundary>
          <ReviewBadgeLayer
            review={review}
            targetId={noteId}
            containerRef={editorContainerRef}
            active={reviewRailHidden}
          />
        </div>

        {/* Local Graph Panel — excluded from marquee/focus-at-end so graph
            drags + clicks aren't hijacked by the editor's marquee zone. */}
        {isLocalGraphOpen && noteId && (
          <div data-marquee-ignore>
            <LocalGraphPanel
              noteId={noteId}
              onClose={() => setIsLocalGraphOpen(false)}
              onOpenFullGraph={() => {
                openTab({
                  type: 'graph',
                  title: 'Graph',
                  icon: 'graph',
                  path: '/graph',
                  isPinned: false,
                  isModified: false,
                  isPreview: false,
                  isDeleted: false
                })
              }}
            />
          </div>
        )}

        {/* Backlinks & linked tasks — separated from content and excluded
            from the marquee/focus-at-end zone. */}
        <div className="mt-10 flex flex-col gap-6" data-marquee-ignore>
          <BacklinksSection
            backlinks={backlinks}
            isLoading={backlinksLoading}
            initialCount={5}
            onBacklinkClick={handleBacklinkClick}
          />

          <LinkedTasksSection
            tasks={linkedTasks}
            isLoading={linkedTasksLoading}
            onTaskClick={handleLinkedTaskClick}
          />
        </div>
      </motion.div>

      {/* Export Dialog */}
      <ExportDialog
        open={isExportDialogOpen}
        onOpenChange={setIsExportDialogOpen}
        noteId={noteId}
        noteTitle={note.title}
      />

      {/* Apply Template Dialog */}
      <ApplyTemplateToNoteDialog
        noteId={noteId}
        isOpen={isApplyTemplateOpen}
        onClose={() => setIsApplyTemplateOpen(false)}
      />

      {/* Version History Panel */}
      <VersionHistory
        open={isVersionHistoryOpen}
        onOpenChange={setIsVersionHistoryOpen}
        noteId={noteId}
        noteTitle={note.title}
        onRestore={() => {
          if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current)
            saveTimeoutRef.current = null
          }
          refetchNote()
        }}
      />

      {/* Move to Folder Dialog */}
      <MoveToFolderDialog
        open={isMoveDialogOpen}
        onOpenChange={setIsMoveDialogOpen}
        noteIds={[noteId]}
        currentFolder={
          note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : ''
        }
        noteTitle={note.title}
        onMove={(targetFolder) => void handleMoveToFolder(targetFolder)}
      />

      {/* Delete confirmation */}
      <AlertDialog
        open={isDeleteConfirmOpen}
        onOpenChange={(open) => !open && setIsDeleteConfirmOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('page.deleteConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('page.deleteConfirm.description', { title: note.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('page.deleteConfirm.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleDeleteConfirm()
              }}
              disabled={isDeleting}
              className="bg-red-500 hover:bg-red-600"
            >
              {isDeleting ? t('page.deleteConfirm.deleting') : t('page.deleteConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </NoteLayout>
  )
}
