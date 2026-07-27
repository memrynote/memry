import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { Plus } from '@/lib/icons'
import { ProjectOverviewNote } from '@/components/tasks/projects/project-overview-note'
import { LinkSearch } from '@/components/filing/link-search'
import { tasksService } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import type { ProjectLinkedNote } from '@memry/rpc/tasks'
import type { LinkedNote } from '@/types'
import { NoteRow } from './rows/note-row'

const log = createLogger('ProjectHubRail')

interface RailOverviewProps {
  projectId: string
  homeNoteId: string | null | undefined
  onHomeNoteChange: (noteId: string | null) => void
  pinnedNotes: ProjectLinkedNote[]
  onOpenNote: (noteId: string) => void
  onNoteIconChange: (noteId: string, icon: string | null) => void
  onChanged: () => void
}

export const RailOverview = ({
  projectId,
  homeNoteId,
  onHomeNoteChange,
  pinnedNotes,
  onOpenNote,
  onNoteIconChange,
  onChanged
}: RailOverviewProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const [isPicking, setIsPicking] = useState(false)

  const handleUnpin = useCallback(
    async (noteId: string): Promise<void> => {
      try {
        const result = await tasksService.setProjectLinkPinned({
          projectId,
          itemId: noteId,
          pinned: false
        })
        if (!result.success) throw new Error(result.error)
        onChanged()
      } catch (error) {
        log.error('Failed to unpin note', extractErrorMessage(error))
        toast.error(extractErrorMessage(error, t('projectHub.rail.unpinError')))
      }
    },
    [projectId, onChanged, t]
  )

  // Picking a note both links it to the project and pins it — one gesture, so
  // the rail never shows a note the Notes tab does not also list.
  const handlePick = useCallback(
    async (notes: LinkedNote[]): Promise<void> => {
      const picked = notes[notes.length - 1]
      if (!picked) return
      setIsPicking(false)
      try {
        const linked = await tasksService.linkProjectItem({
          projectId,
          itemType: 'note',
          itemId: picked.id
        })
        if (!linked.success) throw new Error(linked.error)

        const pinned = await tasksService.setProjectLinkPinned({
          projectId,
          itemId: picked.id,
          pinned: true
        })
        if (!pinned.success) throw new Error(pinned.error)

        onChanged()
      } catch (error) {
        log.error('Failed to pin note', extractErrorMessage(error))
        toast.error(extractErrorMessage(error, t('projectHub.rail.pinError')))
      }
    },
    [projectId, onChanged, t]
  )

  return (
    <section className="px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('projectHub.rail.overview')}
      </h3>

      <ProjectOverviewNote
        projectId={projectId}
        homeNoteId={homeNoteId}
        onHomeNoteChange={onHomeNoteChange}
        className="px-0 py-0"
      />

      {pinnedNotes.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {pinnedNotes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              onOpen={onOpenNote}
              onIconChange={onNoteIconChange}
              onUnpin={(noteId) => void handleUnpin(noteId)}
            />
          ))}
        </ul>
      ) : null}

      {isPicking ? (
        <div className="mt-2">
          <LinkSearch linkedNotes={[]} onLinkedNotesChange={(notes) => void handlePick(notes)} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsPicking(true)}
          className="mt-2 flex items-center gap-1.5 rounded-sm px-1 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t('projectHub.rail.addNote')}
        </button>
      )}
    </section>
  )
}
