import { useT } from '@memry/i18n/renderer'
import type { ProjectLinkedNote } from '@memry/rpc/tasks'
import type { ProjectProgress } from './use-project-hub'
import { RailOverview } from './rail-overview'
import { RailProgress } from './rail-progress'
import { RailDetails } from './rail-details'

interface ProjectRailProps {
  projectId: string
  homeNoteId: string | null | undefined
  onHomeNoteChange: (noteId: string | null) => void
  pinnedNotes: ProjectLinkedNote[]
  progress: ProjectProgress
  createdAt: Date | null
  modifiedAt: Date | null
  counts: { notes: number; files: number; events: number }
  onOpenNote: (noteId: string) => void
  onNoteIconChange: (noteId: string, icon: string | null) => void
  onChanged: () => void
}

export const ProjectRail = ({
  projectId,
  homeNoteId,
  onHomeNoteChange,
  pinnedNotes,
  progress,
  createdAt,
  modifiedAt,
  counts,
  onOpenNote,
  onNoteIconChange,
  onChanged
}: ProjectRailProps): React.JSX.Element => {
  const { t } = useT('tasks')

  return (
    <aside
      data-testid="project-rail"
      aria-label={t('projectHub.rail.details')}
      className="w-80 shrink-0 overflow-y-auto border-s border-border"
    >
      <RailOverview
        projectId={projectId}
        homeNoteId={homeNoteId}
        onHomeNoteChange={onHomeNoteChange}
        pinnedNotes={pinnedNotes}
        onOpenNote={onOpenNote}
        onNoteIconChange={onNoteIconChange}
        onChanged={onChanged}
      />
      <RailProgress progress={progress} />
      <RailDetails createdAt={createdAt} modifiedAt={modifiedAt} counts={counts} />
    </aside>
  )
}
