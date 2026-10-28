import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

import { events } from '../../../generated/bindings'
import { subscribeToEvent } from '@/services/tauri-event'

/**
 * Tell the user when a note's file on disk could not be updated from the
 * editor (#2615): the edit is held by the app, and the file still has the
 * older text until a later pass lands.
 *
 * Main sends one event per run of failed passes for a note. The toast id is
 * per note, so a repeat replaces the open toast instead of stacking another.
 * More than three notes failing within a toast's lifetime is one fault, such
 * as a full disk: their toasts give way to one that counts them.
 * Mounted next to the app, not inside the sync provider: a write-back runs
 * for every vault, signed in or not.
 */
/** More notes failing at once than this is one fault (a full disk): one notice says it. */
const COLLAPSE_AFTER = 3
const TOAST_MS = 15000

export function WritebackFailureNotice(): null {
  const { t } = useT('errors')
  /** The notes told of within a toast's lifetime, with when. */
  const recent = useRef(new Map<string, number>())

  useEffect(
    () =>
      subscribeToEvent(events.crdtWriteBackFailedEvent, (event) => {
        const now = Date.now()
        for (const [id, at] of recent.current) {
          if (now - at > TOAST_MS) recent.current.delete(id)
        }
        recent.current.set(event.noteId, now)
        const description = t('crdt.writebackFailedBody')
        if (recent.current.size > COLLAPSE_AFTER) {
          for (const id of recent.current.keys()) toast.dismiss(`write-back-failed:${id}`)
          toast.warning(t('crdt.writebackFailedTitleMany', { count: recent.current.size }), {
            id: 'write-back-failed:many',
            description,
            duration: TOAST_MS
          })
          return
        }
        toast.warning(
          event.title
            ? t('crdt.writebackFailedTitleNamed', { title: event.title })
            : t('crdt.writebackFailedTitle'),
          {
            id: `write-back-failed:${event.noteId}`,
            description,
            duration: TOAST_MS
          }
        )
      }),
    [t]
  )

  return null
}
