import { useEffect, useState } from 'react'
import { nameKey } from '@memry/shared/note-names'
import { createLogger } from '@/lib/logger'
import { notesService } from '@/services/notes-service'

const log = createLogger('NoteNames')
const DEBOUNCE_MS = 150

export interface NameConflict {
  name: string
  title: string
  /** The draft is the other note's title, not one of its other names. */
  isOtherTitle: boolean
  /** The other note keeps the name and the draft does not resolve here. */
  otherKeepsName: boolean
}

export function useNameConflict(noteId: string | null, draft: string): NameConflict | null {
  const [conflict, setConflict] = useState<NameConflict | null>(null)
  const name = draft.trim()

  useEffect(() => {
    if (!noteId || nameKey(name) === null) return undefined
    let cancelled = false
    const timer = setTimeout(() => {
      notesService
        .resolveByTitle(name)
        .then((note) => {
          if (cancelled) return
          if (!note || note.id === noteId) {
            setConflict(null)
            return
          }
          const isOtherTitle = nameKey(note.title) === nameKey(name)
          setConflict({
            name,
            title: note.title,
            isOtherTitle,
            otherKeepsName: isOtherTitle || note.id < noteId
          })
        })
        .catch((error: unknown) => {
          log.warn('Could not check a draft name against other notes', error)
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [noteId, name])

  return noteId && conflict?.name === name ? conflict : null
}
