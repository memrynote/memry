import { useT } from '@memry/i18n/renderer'
import type { Project } from '@/data/tasks-data'
import type { ProjectHubData } from '../use-project-hub'
import { TaskRow } from '../rows/task-row'
import { NoteRow } from '../rows/note-row'
import { FileRow } from '../rows/file-row'
import { EventRow } from '../rows/event-row'
import { HubSection } from './hub-section'
import type { HubHandlers } from './hub-handlers'

/** How many rows each overview section previews before "view all". */
export const OVERVIEW_PREVIEW_COUNT = 5

interface OverviewTabProps {
  project: Project
  hub: ProjectHubData
  handlers: HubHandlers
}

export const OverviewTab = ({ project, hub, handlers }: OverviewTabProps): React.JSX.Element => {
  const { t } = useT('tasks')

  return (
    <div className="pb-6">
      <HubSection
        title={t('projectHub.tabs.tasks')}
        count={hub.counts.tasks}
        onViewAll={() => handlers.onGoToTab('tasks')}
        onAdd={handlers.onAddTask}
        emptyLabel={t('projectHub.sections.emptyTasks')}
        isEmpty={hub.rowTasks.length === 0}
      >
        {hub.rowTasks.slice(0, OVERVIEW_PREVIEW_COUNT).map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            project={project}
            onOpen={handlers.onOpenTask}
            onStatusChange={handlers.onStatusChange}
            onToggleComplete={handlers.onToggleComplete}
            onPriorityChange={handlers.onPriorityChange}
          />
        ))}
      </HubSection>

      <HubSection
        title={t('projectHub.tabs.notes')}
        count={hub.counts.notes}
        onViewAll={() => handlers.onGoToTab('notes')}
        onAdd={handlers.onAddNote}
        emptyLabel={t('projectHub.sections.emptyNotes')}
        isEmpty={hub.notes.length === 0}
      >
        {hub.notes.slice(0, OVERVIEW_PREVIEW_COUNT).map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            onOpen={handlers.onOpenNote}
            onIconChange={handlers.onNoteIconChange}
          />
        ))}
      </HubSection>

      <HubSection
        title={t('projectHub.tabs.files')}
        count={hub.counts.files}
        onViewAll={() => handlers.onGoToTab('files')}
        onAdd={handlers.onAddFile}
        emptyLabel={t('projectHub.sections.emptyFiles')}
        isEmpty={hub.files.length === 0}
      >
        {hub.files.slice(0, OVERVIEW_PREVIEW_COUNT).map((file) => (
          <FileRow key={file.id} file={file} onOpen={handlers.onOpenFile} />
        ))}
      </HubSection>

      <HubSection
        title={t('projectHub.tabs.events')}
        count={hub.counts.events}
        onViewAll={() => handlers.onGoToTab('events')}
        onAdd={handlers.onAddEvent}
        emptyLabel={t('projectHub.sections.emptyEvents')}
        isEmpty={hub.events.length === 0}
      >
        {hub.events.slice(0, OVERVIEW_PREVIEW_COUNT).map((event) => (
          <EventRow key={event.id} event={event} onOpen={handlers.onOpenEvent} />
        ))}
      </HubSection>
    </div>
  )
}
