import { useT } from '@memry/i18n/renderer'
import type { ProjectHubData } from '../use-project-hub'
import { NoteRow } from '../rows/note-row'
import { FileRow } from '../rows/file-row'
import { EventRow } from '../rows/event-row'
import { HubSection } from './hub-section'
import type { HubHandlers } from './hub-handlers'

type ListKind = 'notes' | 'files' | 'events'

interface ListTabProps {
  kind: ListKind
  hub: ProjectHubData
  handlers: HubHandlers
}

/**
 * The Notes / Files / Events tabs. One component because they differ only in
 * which row renders — splitting them would be three copies of the same shell.
 * Tasks is not here: it keeps the existing virtualized list with its subtasks,
 * drag-and-drop and quick-add.
 */
export const ListTab = ({ kind, hub, handlers }: ListTabProps): React.JSX.Element => {
  const { t } = useT('tasks')

  const onAdd =
    kind === 'notes'
      ? handlers.onAddNote
      : kind === 'files'
        ? handlers.onAddFile
        : handlers.onAddEvent

  const items = hub[kind]

  return (
    <div className="pb-6">
      <HubSection
        title={t(`projectHub.tabs.${kind}`)}
        count={hub.counts[kind]}
        onAdd={onAdd}
        emptyLabel={t(
          kind === 'notes'
            ? 'projectHub.sections.emptyNotes'
            : kind === 'files'
              ? 'projectHub.sections.emptyFiles'
              : 'projectHub.sections.emptyEvents'
        )}
        isEmpty={items.length === 0}
      >
        {kind === 'notes'
          ? hub.notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                onOpen={handlers.onOpenNote}
                onIconChange={handlers.onNoteIconChange}
              />
            ))
          : kind === 'files'
            ? hub.files.map((file) => (
                <FileRow key={file.id} file={file} onOpen={handlers.onOpenFile} />
              ))
            : hub.events.map((event) => (
                <EventRow key={event.id} event={event} onOpen={handlers.onOpenEvent} />
              ))}
      </HubSection>
    </div>
  )
}
