/**
 * EmbeddedNoteEditor — the real BlockNote note editor mounted on an active
 * canvas card. Reuses the outer <ContentArea>, which self-binds the note Y.Doc
 * via the shared yjs-doc-registry (so this + the note tab share one doc with no
 * echo/dupe) whenever collaboration is active. runSideEffects is left to
 * ContentArea's ownership gate.
 *
 * When the editor cannot bind the note's document it falls back to the note's
 * markdown, exactly like a note tab does, and saves it through the note page's
 * own body saves (`useNoteBody`): the note is read again on mount, outside
 * edits reach the editor, and a refused save keeps the typing (#4088).
 */
import React, { useState } from 'react'
import { ContentArea } from '@/components/note/content-area'
import { VersionHistory } from '@/components/note/version-history'
import { useIsNoteLocked } from '@/lib/vault-locks-store'
import { LockedNoteNotice } from '@/components/note/locked-note-notice'
import { useNoteBody } from '@/pages/note/use-note-body'

interface EmbeddedNoteEditorProps {
  noteId: string
}

export const EmbeddedNoteEditor = ({ noteId }: EmbeddedNoteEditorProps): React.JSX.Element => {
  const [versionsOpen, setVersionsOpen] = useState(false)
  const body = useNoteBody(noteId, {
    surface: 'canvas-card',
    showVersionHistory: () => setVersionsOpen(true)
  })
  const { note } = body.query
  const isLocked = useIsNoteLocked(noteId, note?.path ?? null)

  if (!note) {
    return <div className="min-h-0 flex-1 overflow-auto" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isLocked && <LockedNoteNotice className="shrink-0 pb-1" />}
      <div className="min-h-0 flex-1 overflow-auto">
        <ContentArea
          noteId={noteId}
          editable={!isLocked}
          initialContent={body.content}
          contentType="markdown"
          externalContentRevision={body.revision}
          onMarkdownChange={body.onMarkdownChange}
        />
      </div>
      <VersionHistory
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        noteId={noteId}
        noteTitle={note.title}
        onRestore={body.cancelScheduledSave}
      />
    </div>
  )
}
