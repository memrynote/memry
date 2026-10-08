import { useEffect } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

/**
 * Tell the user when a note's file on disk could not be updated from the
 * editor (#2615): the edit is held by the app, and the file still has the
 * older text until a later pass lands.
 *
 * Main sends one event per run of failed passes for a note. The toast id is
 * per note, so a repeat replaces the open toast instead of stacking another.
 * Mounted next to the app, not inside the sync provider: a write-back runs
 * for every vault, signed in or not.
 */
export function WritebackFailureNotice(): null {
  const { t } = useT('errors')

  useEffect(
    () =>
      window.api.onCrdtWriteBackFailed((event) => {
        toast.warning(
          event.title
            ? t('crdt.writebackFailedTitleNamed', { title: event.title })
            : t('crdt.writebackFailedTitle'),
          {
            id: `write-back-failed:${event.noteId}`,
            description: t('crdt.writebackFailedBody'),
            duration: 15000
          }
        )
      }),
    [t]
  )

  return null
}
