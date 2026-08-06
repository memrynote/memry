/**
 * EmbeddedNoteEditor — the real BlockNote note editor mounted on an active
 * canvas card. Reuses the outer <ContentArea>, which self-binds the note Y.Doc
 * via the shared yjs-doc-registry (so this + the note tab share one doc with no
 * echo/dupe) whenever collaboration is active. runSideEffects is left to
 * ContentArea's ownership gate.
 *
 * ContentArea's Yjs collaboration only engages once the sync context reports a
 * live status (idle/syncing/offline) — before that (e.g. no sync session yet)
 * it falls back to a local, non-collaborative BlockNote editor, exactly like
 * a note tab does. So this mirrors note.tsx's own baseline persistence path:
 * fetch the note's current content as `initialContent` (never destroy existing
 * body text) and debounce-save `onMarkdownChange` back to `notesService.update`.
 */
import React, { useCallback, useEffect, useRef } from 'react'
import { ContentArea } from '@/components/note/content-area'
import { useNote } from '@/hooks/use-notes-query'
import { notesService } from '@/services/notes-service'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'

const log = createLogger('EmbeddedNoteEditor')

const SAVE_DEBOUNCE_MS = 1000

interface EmbeddedNoteEditorProps {
  noteId: string
}

export const EmbeddedNoteEditor = ({ noteId }: EmbeddedNoteEditorProps): React.JSX.Element => {
  const { note } = useNote(noteId)

  const lastSavedContentRef = useRef<string | null>(null)
  const pendingContentRef = useRef<string | null>(null)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (note && lastSavedContentRef.current === null) {
      lastSavedContentRef.current = note.content
    }
  }, [note])

  const flush = useCallback(async (): Promise<void> => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    const pending = pendingContentRef.current
    if (pending === null) return
    pendingContentRef.current = null
    try {
      await notesService.update({ id: noteId, content: pending })
      lastSavedContentRef.current = pending
    } catch (err) {
      log.error('Failed to save note', { noteId, error: err })
      trackRendererError('canvas_card_note_save', err)
      // Put the unsaved text back so the next flush retries instead of
      // dropping it — unless a newer edit already replaced it mid-await.
      if (pendingContentRef.current === null) {
        pendingContentRef.current = pending
      }
    }
  }, [noteId])

  useEffect(() => {
    const registryKey = `canvas-card:${noteId}`
    registerPendingSave(registryKey, flush)
    return () => {
      unregisterPendingSave(registryKey)
      void flush()
    }
  }, [noteId, flush])

  const handleMarkdownChange = useCallback(
    (markdown: string) => {
      if (markdown === lastSavedContentRef.current) return
      pendingContentRef.current = markdown
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => {
        saveTimeoutRef.current = null
        void flush()
      }, SAVE_DEBOUNCE_MS)
    },
    [flush]
  )

  if (!note) {
    return <div className="min-h-0 flex-1 overflow-auto" />
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <ContentArea
        noteId={noteId}
        initialContent={note.content}
        contentType="markdown"
        onMarkdownChange={handleMarkdownChange}
      />
    </div>
  )
}
