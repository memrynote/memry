/**
 * Missing attachment card (#1713): detects a file block whose attachment is not
 * on disk and renders the repair hint in its place.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { File } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import { getAttachmentRevision, subscribeToAttachmentRevisions } from '@/lib/attachment-revision'
import { HAS_SCHEME, useAttachmentNoteId } from './note-file-url-context'

interface AttachmentPresence {
  missing: boolean
  /** The on-disk filename the ref expects, for the card's repair hint. */
  expectedFilename: string | null
}

const ATTACHMENT_PRESENT: AttachmentPresence = { missing: false, expectedFilename: null }

/**
 * Whether the block's attachment is actually on disk (after main's self-heal
 * pass had its chance). Re-checked when an attachment for this note lands, so
 * a file that syncs in later clears the card without a remount.
 */
export function useAttachmentPresence(url: string): AttachmentPresence {
  const noteId = useAttachmentNoteId()
  const revision = useSyncExternalStore(subscribeToAttachmentRevisions, () =>
    getAttachmentRevision(noteId)
  )
  const [presence, setPresence] = useState<AttachmentPresence>(ATTACHMENT_PRESENT)

  // A changed note or ref means any pending resolve is now for a different
  // file: reset to neutral in the same render rather than in the effect below
  // — the "adjusting state during render" pattern at
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [prevKey, setPrevKey] = useState({ noteId, url })
  if (prevKey.noteId !== noteId || prevKey.url !== url) {
    setPrevKey({ noteId, url })
    setPresence(ATTACHMENT_PRESENT)
  }

  useEffect(() => {
    // Only vault refs (note-relative or legacy memry-file) are checkable;
    // http/data urls are not attachments. Surfaces without a note id (and
    // tests without the IPC surface) just never show the card.
    const isVaultRef = Boolean(url) && (!HAS_SCHEME.test(url) || url.startsWith('memry-file:'))
    if (!noteId || !isVaultRef || !window.api?.notes?.resolveAttachment) {
      return
    }
    let cancelled = false
    window.api.notes
      .resolveAttachment(noteId, url)
      .then((info) => {
        if (cancelled) return
        setPresence(
          info.exists
            ? ATTACHMENT_PRESENT
            : { missing: true, expectedFilename: info.storedFilename }
        )
      })
      .catch(() => {
        // An unresolvable url (invalid path shape) is not "missing on disk" —
        // leave the block to its normal rendering.
        if (!cancelled) setPresence(ATTACHMENT_PRESENT)
      })
    return () => {
      cancelled = true
    }
  }, [noteId, url, revision])

  return presence
}

export function MissingAttachmentCard({
  name,
  expectedFilename,
  menu
}: {
  name: string
  expectedFilename: string | null
  menu?: React.ReactNode
}) {
  const { t: tPhaseF } = useT('notes')
  return (
    <div
      data-testid="attachment-missing-card"
      className="file-attachment-missing relative flex items-center gap-3 rounded-md border border-dashed border-border bg-muted/30 p-3"
    >
      <File className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {tPhaseF('editor.attachmentMenu.missingTitle')}
          {expectedFilename
            ? ` — ${tPhaseF('editor.attachmentMenu.missingExpected', { name: expectedFilename })}`
            : ''}
        </p>
      </div>
      {menu}
    </div>
  )
}
