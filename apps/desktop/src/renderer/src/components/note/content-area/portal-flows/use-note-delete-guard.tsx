/**
 * The delete guard for whole notes. A note other notes show through a portal
 * or link to is not gone quietly: before the delete runs, the user sees which
 * notes it reaches and answers. A note used nowhere else deletes as before.
 *
 * Call `confirmNoteDelete` after the caller's own confirm and before the
 * delete IPC; delete only when it resolves true. Render `dialog` once.
 *
 * @module note/content-area/portal-flows/use-note-delete-guard
 */

import { useCallback, useMemo, type ReactElement } from 'react'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'
import { getPortalUsage, type PortalHost } from './portal-api'
import { usePortalDeleteConfirm } from './portal-delete-dialog'

const log = createLogger('NoteDeleteGuard')

export interface NoteToDelete {
  id: string
  title: string
}

/** One row per note that shows or links to any of `notes`, other than `notes` themselves. */
export async function findNoteHosts(
  notes: readonly NoteToDelete[],
  getUsage: (noteId: string) => Promise<PortalHost[]> = getPortalUsage
): Promise<PortalHost[]> {
  const deleting = new Set(notes.map((note) => note.id))
  const byNote = new Map<string, PortalHost>()
  for (const hosts of await Promise.all(notes.map((note) => getUsage(note.id)))) {
    for (const host of hosts) {
      if (!deleting.has(host.noteId) && !byNote.has(host.noteId)) byNote.set(host.noteId, host)
    }
  }
  return [...byNote.values()]
}

export function useNoteDeleteGuard(): {
  confirmNoteDelete: (notes: readonly NoteToDelete[]) => Promise<boolean>
  dialog: ReactElement
} {
  const { t } = useT('notes')
  const { confirm, dialog } = usePortalDeleteConfirm()

  const confirmNoteDelete = useCallback(
    async (notes: readonly NoteToDelete[]): Promise<boolean> => {
      if (notes.length === 0) return true
      let hosts: PortalHost[]
      try {
        hosts = await findNoteHosts(notes)
      } catch (err) {
        // A failed lookup must not make delete unusable.
        log.error('Usage lookup failed before note delete', err)
        return true
      }
      if (hosts.length === 0) return true
      const choice = await confirm({
        subject: 'note',
        title:
          notes.length === 1
            ? notes[0].title
            : t('portalFlows.deleteGuard.manyNotes', { count: notes.length }),
        sourceTitle: notes[0].title,
        hosts,
        canRemoveHere: false
      })
      return choice === 'everywhere'
    },
    [confirm, t]
  )

  return useMemo(() => ({ confirmNoteDelete, dialog }), [confirmNoteDelete, dialog])
}
