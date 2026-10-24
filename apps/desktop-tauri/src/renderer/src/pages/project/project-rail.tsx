import { useCallback, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ProjectLinkedNote } from '@memry/rpc/tasks'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import type { ProjectProgress } from './use-project-hub'
import { PROJECT_SCROLL_KEYS } from './project-view-state'
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

  // The rail scrolls beside whichever sub-tab is showing, so it needs its own
  // key: a tab holds one scroll record and the rail's offset must never be
  // applied to the tab pane's scroller, or the other way round.
  const scrollRef = useRef<HTMLElement>(null)
  const getScrollElement = useCallback(() => scrollRef.current, [])
  useTabScrollRestore({ getScrollElement, key: PROJECT_SCROLL_KEYS.rail })

  return (
    <aside
      ref={scrollRef}
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
