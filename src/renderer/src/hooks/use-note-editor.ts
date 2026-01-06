/**
 * T029: Unified Note Editor Hook
 *
 * Provides consolidated state management for note editing with:
 * - Auto-save with debouncing (1 second delay)
 * - Save status tracking (idle, saving, saved, error)
 * - Unified interface for title, content, emoji, tags
 * - Error handling with recovery
 *
 * @module hooks/use-note-editor
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { notesService, onNoteDeleted, onNoteExternalChange } from '@/services/notes-service'
import type { Note } from '../../../preload/index.d'
import { toast } from 'sonner'

// ============================================================================
// Types
// ============================================================================

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface UseNoteEditorOptions {
  /** Debounce delay in milliseconds (default: 1000) */
  debounceMs?: number
  /** Auto-save on content change (default: true) */
  autoSave?: boolean
  /** Show toast notifications on errors (default: true) */
  showToasts?: boolean
}

export interface UseNoteEditorReturn {
  // State
  note: Note | null
  isLoading: boolean
  saveStatus: SaveStatus
  error: string | null
  isDeleted: boolean

  // Actions
  loadNote: () => Promise<void>
  updateTitle: (title: string) => Promise<void>
  updateContent: (content: string) => void
  updateEmoji: (emoji: string | null) => Promise<void>
  updateTags: (tags: string[]) => Promise<void>

  // Manual save (bypasses debounce)
  saveNow: () => Promise<void>

  // Clear error state
  clearError: () => void
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Hook for unified note editor state management.
 *
 * @param noteId - The ID of the note to edit
 * @param options - Configuration options
 * @returns Object with note state and editor actions
 *
 * @example
 * ```tsx
 * function NoteEditor({ noteId }) {
 *   const {
 *     note,
 *     isLoading,
 *     saveStatus,
 *     updateTitle,
 *     updateContent,
 *     updateEmoji,
 *     updateTags
 *   } = useNoteEditor(noteId)
 *
 *   if (isLoading) return <Spinner />
 *
 *   return (
 *     <>
 *       <SaveStatus status={saveStatus} />
 *       <TitleInput value={note?.title} onChange={updateTitle} />
 *       <EmojiPicker value={note?.emoji} onChange={updateEmoji} />
 *       <ContentEditor value={note?.content} onChange={updateContent} />
 *     </>
 *   )
 * }
 * ```
 */
export function useNoteEditor(
  noteId: string | null,
  options: UseNoteEditorOptions = {}
): UseNoteEditorReturn {
  const { debounceMs = 1000, autoSave = true, showToasts = true } = options

  // State
  const [note, setNote] = useState<Note | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isDeleted, setIsDeleted] = useState(false)

  // Refs for tracking
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastSavedContentRef = useRef<string>('')
  const pendingContentRef = useRef<string | null>(null)

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
    setIsDeleted(false)

    try {
      const loadedNote = await notesService.get(noteId)
      if (loadedNote) {
        setNote(loadedNote)
        lastSavedContentRef.current = loadedNote.content
      } else {
        setError('Note not found')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load note'
      setError(message)
      if (showToasts) {
        toast.error(message)
      }
    } finally {
      setIsLoading(false)
    }
  }, [noteId, showToasts])

  // Load note on mount and noteId change
  useEffect(() => {
    loadNote()
  }, [loadNote])

  // ============================================================================
  // Event Listeners
  // ============================================================================

  // Listen for note deletion events
  useEffect(() => {
    if (!noteId) return

    const handleDeleted = (event: { id: string }) => {
      if (event.id === noteId) {
        setIsDeleted(true)
      }
    }

    const handleExternalChange = (event: { id: string; type: string }) => {
      if (event.id === noteId && event.type === 'deleted') {
        setIsDeleted(true)
      }
    }

    const unsubDeleted = onNoteDeleted(handleDeleted)
    const unsubExternal = onNoteExternalChange(handleExternalChange)

    return () => {
      unsubDeleted()
      unsubExternal()
    }
  }, [noteId])

  // Cleanup save timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [])

  // ============================================================================
  // Save Logic
  // ============================================================================

  const performSave = useCallback(
    async (content: string) => {
      if (!noteId || !note || isDeleted) return

      setSaveStatus('saving')

      try {
        const result = await notesService.update({ id: noteId, content })
        if (result) {
          setNote(result)
          lastSavedContentRef.current = content
          setSaveStatus('saved')

          // Reset to idle after 2 seconds
          setTimeout(() => {
            setSaveStatus((current) => (current === 'saved' ? 'idle' : current))
          }, 2000)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to save'
        setError(message)
        setSaveStatus('error')
        if (showToasts) {
          toast.error(message)
        }
      }
    },
    [noteId, note, isDeleted, showToasts]
  )

  // ============================================================================
  // Actions
  // ============================================================================

  const updateTitle = useCallback(
    async (title: string) => {
      if (!noteId || !note || title === note.title || isDeleted) return

      try {
        const result = await notesService.rename(noteId, title)
        if (result) {
          setNote(result)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to rename'
        setError(message)
        if (showToasts) {
          toast.error(message)
        }
      }
    },
    [noteId, note, isDeleted, showToasts]
  )

  const updateContent = useCallback(
    (content: string) => {
      if (!noteId || !note || isDeleted) return

      // Skip if content hasn't changed
      if (content === lastSavedContentRef.current) return

      // Store pending content
      pendingContentRef.current = content

      if (!autoSave) return

      // Clear previous timeout
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }

      // Set status to indicate pending changes
      setSaveStatus('idle')

      // Schedule save
      saveTimeoutRef.current = setTimeout(() => {
        if (pendingContentRef.current !== null) {
          performSave(pendingContentRef.current)
          pendingContentRef.current = null
        }
      }, debounceMs)
    },
    [noteId, note, isDeleted, autoSave, debounceMs, performSave]
  )

  const updateEmoji = useCallback(
    async (emoji: string | null) => {
      if (!noteId || !note || isDeleted) return

      try {
        const result = await notesService.update({ id: noteId, emoji })
        if (result) {
          setNote(result)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update emoji'
        setError(message)
        if (showToasts) {
          toast.error(message)
        }
      }
    },
    [noteId, note, isDeleted, showToasts]
  )

  const updateTags = useCallback(
    async (tags: string[]) => {
      if (!noteId || !note || isDeleted) return

      try {
        const result = await notesService.update({ id: noteId, tags })
        if (result) {
          setNote(result)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update tags'
        setError(message)
        if (showToasts) {
          toast.error(message)
        }
      }
    },
    [noteId, note, isDeleted, showToasts]
  )

  const saveNow = useCallback(async () => {
    // Clear any pending timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }

    // Save pending content if any
    if (pendingContentRef.current !== null) {
      await performSave(pendingContentRef.current)
      pendingContentRef.current = null
    }
  }, [performSave])

  const clearError = useCallback(() => {
    setError(null)
    if (saveStatus === 'error') {
      setSaveStatus('idle')
    }
  }, [saveStatus])

  // ============================================================================
  // Return
  // ============================================================================

  return {
    // State
    note,
    isLoading,
    saveStatus,
    error,
    isDeleted,

    // Actions
    loadNote,
    updateTitle,
    updateContent,
    updateEmoji,
    updateTags,
    saveNow,
    clearError
  }
}
