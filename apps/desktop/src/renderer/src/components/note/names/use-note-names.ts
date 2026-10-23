import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { applyAliasDelta, nameKey, type AliasDelta } from '@memry/shared/note-names'
import { useT } from '@memry/i18n/renderer'
import { extractErrorMessage } from '@/lib/ipc-error'
import { notesService } from '@/services/notes-service'

export interface NoteNames {
  names: string[]
  add: (name: string) => void
  remove: (name: string) => void
  rename: (from: string, to: string) => void
}

export function useNoteNames(
  noteId: string | null,
  title: string,
  aliases: readonly string[]
): NoteNames {
  const { t } = useT('notes')
  const [names, setNames] = useState<string[]>(() => [...aliases])
  const latestEdit = useRef(0)

  const source = aliases.join('\u0000')
  const [seenSource, setSeenSource] = useState({ noteId, source })
  if (seenSource.noteId !== noteId || seenSource.source !== source) {
    setSeenSource({ noteId, source })
    setNames([...aliases])
  }

  const namesRef = useRef(names)
  useEffect(() => {
    namesRef.current = names
  }, [names])

  const edit = useCallback(
    (delta: AliasDelta) => {
      if (!noteId) return
      const before = namesRef.current
      const edit = ++latestEdit.current
      setNames(applyAliasDelta(title, before, delta))
      notesService
        .editAliases({ id: noteId, add: [...delta.add], remove: [...delta.remove] })
        .then((result) => {
          if (edit === latestEdit.current) setNames(result.aliases)
        })
        .catch((error: unknown) => {
          if (edit === latestEdit.current) setNames(before)
          toast.error(extractErrorMessage(error, t('names.saveFailed')))
        })
    },
    [noteId, title, t]
  )

  const add = useCallback(
    (name: string) => {
      edit({ add: [name], remove: [] })
    },
    [edit]
  )
  const remove = useCallback(
    (name: string) => {
      edit({ add: [], remove: [name] })
    },
    [edit]
  )
  const rename = useCallback(
    (from: string, to: string) => {
      if (nameKey(from) === nameKey(to) && from.trim() === to.trim()) return
      edit({ add: [to], remove: [from] })
    },
    [edit]
  )

  return { names, add, remove, rename }
}
